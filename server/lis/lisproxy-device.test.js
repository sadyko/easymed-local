// LIS_PROXY_V1 — прибор за LIS Proxy: кто он (имя + адрес, подпись при смене
// адреса), смена адреса не снимает подтверждения BS-200, свой порт и прокси
// не берут чужих строк, слушатели строк прокси не видят, «на связи» — на
// каждом запросе с ключом.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ensureDevice, ensureProxyDevice, MAX_PROXY_FOUND } from './discover.js';
import { startLisListeners, stopLisListeners, listenerStatus } from './index.js';
import { freshDb, addProxyDevice, bindPanel, startProxyApp, post, fixture, device, rows } from '../test-helpers/lisproxy-clinic.js';

test('новый прибор LIS Proxy — находка без модели; адрес без «::ffff:», подпись запомнены; host и sending_app пусты', () => {
  const db = freshDb();
  const r = ensureProxyDevice(db, { name: 'bs200', label: 'LAB-PC-1', ip: '::ffff:192.168.1.21' });
  assert.equal(r.reason, 'заведён по первому запросу LIS Proxy');
  const d = r.device;
  assert.deepEqual([d.name, d.profile, d.transport, d.host, d.port, d.enabled, d.discovered, d.added, d.via, d.proxy_name, d.proxy_label, d.proxy_ip, d.sending_app],
    ['bs200', '', 'mllp', '', null, 1, 1, 0, 'lisproxy', 'bs200', 'LAB-PC-1', '192.168.1.21', null]);
});

test('тот же адрес и то же имя (регистр не важен) — та же строка; новая подпись запоминается', () => {
  const db = freshDb();
  const id = ensureProxyDevice(db, { name: 'bs200', label: 'LAB-PC-1', ip: '10.0.0.5' }).device.id;
  const r = ensureProxyDevice(db, { name: 'BS200', label: 'LAB-PC-1b', ip: '10.0.0.5' });
  assert.equal(r.device.id, id);
  assert.equal(r.moved, null);
  assert.equal(r.device.proxy_label, 'LAB-PC-1b');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_devices').get().c, 1);
});

test('адрес лабораторного ПК сменился (DHCP): та же строка, адрес переписан; подтверждения BS-200 и эпоха кодов целы', () => {
  const db = freshDb();
  const id = addProxyDevice(db, { name: 'bs200', label: 'LAB-PC-1', ip: '192.168.1.21', profile: 'mindray-bs-200' });
  db.exec("INSERT INTO services (id, name, is_lab) VALUES (9, 'Биохимия', 1)");
  bindPanel(db, { id: 5, serviceId: 9, deviceId: id, name: 'Биохимия', lines: [['GLU', 'Глюкоза', 'GLU']] });
  const r = ensureProxyDevice(db, { name: 'bs200', label: 'LAB-PC-1', ip: '192.168.1.35' });
  assert.equal(r.device.id, id);
  assert.deepEqual(r.moved, { from: '192.168.1.21', to: '192.168.1.35' });
  assert.equal(r.device.proxy_ip, '192.168.1.35');
  assert.equal(r.device.code_epoch, 0, 'эпоха не выросла');
  assert.deepEqual(db.prepare('SELECT device_code_confirmed_device_id AS d, device_code_confirmed_epoch AS e FROM lab_panel_analytes').get(), { d: id, e: 0 });
});

test('новый адрес и другая подпись, или две строки с тем же именем и подписью — новая находка, а не склейка', () => {
  const db = freshDb();
  const a = addProxyDevice(db, { name: 'bs200', label: 'LAB-PC-1', ip: '10.0.0.5' });
  const other = ensureProxyDevice(db, { name: 'bs200', label: 'LAB-PC-2', ip: '10.0.0.6' });
  assert.notEqual(other.device.id, a);
  assert.equal(other.device.name, 'bs200 (LAB-PC-2)', 'имя занято — с подписью');
  addProxyDevice(db, { name: 'bc780x', label: 'LABPC', ip: '10.0.0.7' });
  addProxyDevice(db, { name: 'bc780x', label: 'LABPC', ip: '10.0.0.8' });
  const third = ensureProxyDevice(db, { name: 'bc780x', label: 'LABPC', ip: '10.0.0.9' });
  assert.equal(third.moved, null);
  assert.equal(third.device.added, 0, 'двусмысленно — новая находка');
});

test('пустое имя — прибора нет; предел — 20 находок LIS Proxy, свой порт считает свои', () => {
  const db = freshDb();
  assert.deepEqual(ensureProxyDevice(db, { name: '  ', ip: '10.0.0.5' }), { device: null, moved: null, reason: 'LIS Proxy не прислал имя анализатора' });
  for (let i = 0; i < MAX_PROXY_FOUND; i++) ensureProxyDevice(db, { name: 'a' + i, ip: '10.0.0.5' });
  const over = ensureProxyDevice(db, { name: 'lishniy', ip: '10.0.0.5' });
  assert.equal(over.device, null);
  assert.match(over.reason, /предел найденных приборов LIS Proxy/);
  const mllp = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.77', port: 2575 });
  assert.ok(mllp.created, 'находки прокси не съедают предел своего порта');
});

test('свой порт не берёт строку LIS Proxy: MLLP «Mindray» не забирает прибор прокси с именем «Mindray» (шаг 2 — по имени)', () => {
  const db = freshDb();
  const pid = addProxyDevice(db, { name: 'Mindray', added: 0 });
  const r = ensureDevice(db, { sendingApp: 'Mindray', sendingFacility: 'BS-200E', peer: '10.0.0.9', port: 2575 });
  assert.ok(r.device && r.created && r.device.id !== pid);
  assert.deepEqual(db.prepare('SELECT host, proxy_ip FROM lab_devices WHERE id = ?').get(pid), { host: '', proxy_ip: '127.0.0.1' });
});

test('прибор прокси не берёт строку своего порта с тем же именем и адресом', () => {
  const db = freshDb();
  const own = ensureDevice(db, { sendingApp: 'bs200', peer: '127.0.0.1', port: 2575 }).device;
  const r = ensureProxyDevice(db, { name: 'bs200', ip: '127.0.0.1' });
  assert.notEqual(r.device.id, own.id);
  assert.equal(r.device.via, 'lisproxy');
});

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '0.0.0.0', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

test('слушатели пропускают строки LIS Proxy: ни порта, ни звонка', async () => {
  const db = freshDb();
  const lisPort = await freePort();
  const p1 = await freePort();
  const prev = process.env.LIS_PORT;
  process.env.LIS_PORT = String(lisPort);
  db.prepare(`INSERT INTO lab_devices (name, profile, transport, host, port, enabled, discovered, added, dial, via, proxy_name, proxy_ip)
              VALUES ('p1', '', 'mllp', '', ?, 1, 1, 1, 0, 'lisproxy', 'p1', '127.0.0.1'),
                     ('p2', '', 'mllp', '127.0.0.1', ?, 1, 1, 1, 1, 'lisproxy', 'p2', '127.0.0.1')`).run(p1, p1);
  try {
    await startLisListeners(db, { log: () => {} });
    const st = listenerStatus();
    assert.ok(st.listening.includes(lisPort), 'порт LIS по умолчанию слушается');
    assert.ok(!st.listening.includes(p1), 'порт строки прокси не слушается');
    assert.deepEqual(st.dialing, [], 'строке прокси не звоним');
  } finally {
    await stopLisListeners();
    if (prev === undefined) delete process.env.LIS_PORT; else process.env.LIS_PORT = prev;
    db.close();
  }
});

test('«на связи» и прибор в журнале — на каждом запросе с ключом: и в лотке, и рабочий список, и мусор; с неверным ключом — нет', async () => {
  const db = freshDb();
  const app = await startProxyApp(db);
  try {
    await post(app.url, fixture('results', 'bs200_patient_number_as_barcode'));
    await post(app.url, fixture('orders', 'cl_garbage_all'));
    await post(app.url, fixture('results', 'bc20_take_mode'));
    await post(app.base + '/api/lisproxy?key=WRONG', fixture('results', 'bc780_wbc'));
    for (const name of ['bs200', 'cl900i', 'bc20x']) {
      const d = device(db, name);
      assert.ok(d && d.last_seen_at, name + ' на связи');
    }
    assert.equal(device(db, 'bc780x'), undefined, 'неверный ключ прибор не заводит');
    assert.ok(rows(db).every((m) => m.device_id != null), 'у каждой строки журнала — прибор');
  } finally { await app.close(); db.close(); }
});
