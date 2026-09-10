// discover.test.js — LIS_AUTODISCOVER_V1: прибор заводится сам, но ровно один
// раз, и подобранная модель остаётся ДОГАДКОЙ, а не фактом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { ensureDevice, guessProfile } from './discover.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
const devices = (db) => db.prepare('SELECT * FROM lab_devices ORDER BY id').all();

test('модель узнаётся по имени прибора, как бы он его ни написал', () => {
  assert.equal(guessProfile('BC-5300').key, 'mindray-bc-5300');
  assert.equal(guessProfile('bc 5300').key, 'mindray-bc-5300');
  assert.equal(guessProfile('MINDRAY BC-5300').key, 'mindray-bc-5300', 'имя с производителем — тот же прибор');
  assert.equal(guessProfile('BS-240').key, 'mindray-bs-240');
});

test('незнакомое имя — это null, а не случайный профиль', () => {
  assert.equal(guessProfile('Sysmex XN-1000'), null);
  assert.equal(guessProfile(''), null);
  assert.equal(guessProfile(null), null);
});

test('первое сообщение заводит прибор: имя из MSH-3, модель подобрана, адрес запомнен', () => {
  const db = fresh();
  assert.equal(devices(db).length, 0);

  const out = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9', port: 2575 });
  assert.equal(out.created, true);
  assert.equal(out.device.name, 'BC-5300');
  assert.equal(out.device.profile, 'mindray-bc-5300');
  assert.equal(out.device.host, '10.0.0.9');
  assert.equal(out.device.enabled, 1);
  assert.equal(out.device.discovered, 1, 'найденный прибор помечен: модель подобрана, человек её не подтверждал');
  db.close();
});

test('второе сообщение того же прибора НЕ заводит вторую строку', () => {
  const db = fresh();
  ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9' });
  ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9' });
  ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9' });
  assert.equal(devices(db).length, 1, 'каждое сообщение заводило бы прибор — за день их стали бы сотни');
  db.close();
});

test('сменившийся адрес (DHCP) переезжает на ту же строку, а не плодит новую', () => {
  const db = fresh();
  ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9' });
  const out = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.55' });
  assert.equal(out.created, false);
  assert.equal(devices(db).length, 1);
  assert.equal(devices(db)[0].host, '10.0.0.55', 'адрес обязан обновиться — иначе прибор «потеряется» после перезагрузки роутера');
  db.close();
});

test('незнакомая модель заводится с пустым профилем — лаборант выберет сам', () => {
  const db = fresh();
  const out = ensureDevice(db, { sendingApp: 'Sysmex XN-1000', peer: '10.0.0.7' });
  assert.equal(out.created, true);
  assert.equal(out.device.name, 'Sysmex XN-1000');
  assert.equal(out.device.profile, '', 'угаданный наугад профиль был бы хуже пустого');
  db.close();
});

test('заведённый руками прибор с этим адресом используется как есть, без находки', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (name, profile, host, port) VALUES ('Гематология','mindray-bc-20','10.0.0.9',2575)").run();
  const out = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9' });
  assert.equal(out.created, false);
  assert.equal(out.device.name, 'Гематология', 'выбор человека не перебивается тем, как прибор себя назвал');
  assert.equal(devices(db).length, 1);
  db.close();
});

test('единственный прибор без адреса считается отправителем — клиника с одним анализатором не заполняет поле', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (name, profile, host) VALUES ('Гематология','mindray-bc-20','')").run();
  const out = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9' });
  assert.equal(out.created, false);
  assert.equal(out.device.name, 'Гематология');
  db.close();
});

test('потолок находок: порт неаутентифицирован, и бесконечно плодить строки нельзя', () => {
  const db = fresh();
  for (let i = 0; i < 20; i++) ensureDevice(db, { sendingApp: 'ANALYZER-' + i, peer: '10.0.0.' + i });
  assert.equal(devices(db).length, 20);

  const out = ensureDevice(db, { sendingApp: 'ANALYZER-21', peer: '10.0.0.21' });
  assert.equal(out.device, null);
  assert.match(out.reason, /предел/);
  assert.equal(devices(db).length, 20, 'кто угодно в сети клиники иначе наплодил бы строк');
  db.close();
});
