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

test('прибор с другого адреса заводится ОТДЕЛЬНОЙ строкой, даже если назвался так же', () => {
  // РЕШЕНИЕ, а не недосмотр. Два одинаковых анализатора представляются по HL7
  // одинаково (MSH-3 — модель, не серийный номер), поэтому «тот же прибор с
  // новым адресом по DHCP» неотличим от «второго такого же прибора».
  //
  // Раньше строка переезжала на новый адрес — и два настоящих прибора
  // склеивались в один: адрес и «последнее сообщение» прыгали между ними, и ни
  // одной строке нельзя было верить. Теперь лишняя строка после смены адреса
  // ВИДНА в списке и удаляется одним щелчком, а результаты продолжают ложиться:
  // панель принимает от прибора той же модели.
  const db = fresh();
  ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9' });
  const out = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.55' });
  assert.equal(out.created, true);
  assert.equal(devices(db).length, 2);
  assert.equal(devices(db)[0].host, '10.0.0.9', 'прежняя строка не трогается — иначе это снова тихая склейка');
  assert.equal(devices(db)[1].host, '10.0.0.55');
  db.close();
});

test('прибор, заведённый БЕЗ адреса, принимает первый заговоривший — адрес просто дописывается', () => {
  // Обратный случай: строку создали заранее (или прибор ещё не говорил), адрес
  // пуст. Заводить вторую строку здесь было бы глупо — заполняем эту.
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (name, profile, host, discovered) VALUES ('BC-5300','mindray-bc-5300','',1)").run();
  db.prepare("INSERT INTO lab_devices (name, profile, host, enabled) VALUES ('Биохимия','mindray-bs-240','10.0.0.80',1)").run();
  const out = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9' });
  assert.equal(out.created, false);
  assert.equal(out.device.host, '10.0.0.9');
  assert.equal(devices(db).length, 2);
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

// ── НЕСКОЛЬКО ПРИБОРОВ ─────────────────────────────────────────────────────
// В лаборатории обычное дело — два одинаковых анализатора. По HL7 они
// представляются ОДИНАКОВО (MSH-3 = модель), и различает их только адрес.

test('два одинаковых прибора на разных адресах — это ДВА прибора, а не один', () => {
  const db = fresh();
  const a = ensureDevice(db, { sendingApp: 'BC-20', peer: '10.0.0.11' });
  const b = ensureDevice(db, { sendingApp: 'BC-20', peer: '10.0.0.12' });

  assert.equal(a.created, true);
  assert.equal(b.created, true, 'второй прибор был поглощён первым — лаборатория не увидела бы, что их два');
  assert.equal(devices(db).length, 2);
  assert.notEqual(devices(db)[0].host, devices(db)[1].host);
  // Имена обязаны различаться, иначе в списке две неразличимые строки.
  assert.notEqual(devices(db)[0].name, devices(db)[1].name);
  assert.match(devices(db)[1].name, /10\.0\.0\.12/, 'адрес в имени — единственное, чем они отличаются');
  db.close();
});

test('каждый из двух одинаковых приборов дальше находит СВОЮ строку', () => {
  const db = fresh();
  ensureDevice(db, { sendingApp: 'BC-20', peer: '10.0.0.11' });
  ensureDevice(db, { sendingApp: 'BC-20', peer: '10.0.0.12' });

  const again = ensureDevice(db, { sendingApp: 'BC-20', peer: '10.0.0.11' });
  assert.equal(again.created, false);
  assert.equal(again.device.host, '10.0.0.11');
  assert.equal(devices(db).length, 2, 'повторные сообщения не должны плодить строк');
  db.close();
});

test('с одного адреса, но ДРУГАЯ модель — это другой прибор, а не тот же', () => {
  // Бывает на одном лабораторном ПК (или за NAT): два прибора видны системе с
  // одного адреса. Совпадения адреса мало — если прибор назвался другой
  // моделью, приписывать его чужой строке нельзя: панель кормилась бы данными
  // не того аппарата.
  const db = fresh();
  const a = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9' });
  const b = ensureDevice(db, { sendingApp: 'BS-240', peer: '10.0.0.9' });

  assert.equal(b.created, true, 'биохимия приписалась к строке гематологии');
  assert.notEqual(a.device.id, b.device.id);
  assert.equal(b.device.profile, 'mindray-bs-240');
  db.close();
});

test('с одного адреса и ТА ЖЕ модель — та же строка, лишней не появляется', () => {
  const db = fresh();
  const a = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9' });
  const b = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9' });
  assert.equal(b.created, false);
  assert.equal(a.device.id, b.device.id);
  assert.equal(devices(db).length, 1);
  db.close();
});
