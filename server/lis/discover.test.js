// discover.test.js — LIS_AUTODISCOVER_V1: прибор заводится сам, но ровно один
// раз, и подобранная модель остаётся ДОГАДКОЙ, а не фактом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { ensureDevice, guessProfile } from './discover.js';
import { writableColumns } from '../db/schema-registry.js';   // LIS_ANALYZER_LIST_V1 (ревью C1)

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
  // LIS_DISCOVERY_FIX_V1 — модель строки не противоречит отправителю (было
  // 'mindray-bc-20' при «BC-5300»: по правилу владельца 2026-09-29 такую
  // строку прибор другой модели не забирает — отдельный тест ниже).
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (name, profile, host) VALUES ('Гематология','mindray-bc-5300','')").run();
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

// LIS_ANALYZER_LIST_V1 — находка ждёт нажатия «Добавить» (решение владельца
// 2026-09-29); строка, заведённая человеком, уже добавлена.
test('новая находка заводится «не добавленной», заведённый руками — добавлен', () => {
  const db = fresh();
  const out = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.12', port: 2575 });
  assert.equal(out.created, true);
  assert.equal(out.device.added, 0, 'находка ждёт одного нажатия в «Добавить прибор»');
  const id = db.prepare("INSERT INTO lab_devices (name, profile) VALUES ('Руками', 'mindray-bs-240')").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT added FROM lab_devices WHERE id = ?').get(id).added, 1);
  db.close();
});

// ── LIS_ANALYZER_LIST_V1, ревью C1 — «Добавить» не меняет маршрутизацию ─────
// «Добавить» писал discovered = 0, а для ensureDevice discovered = 0 значит
// «заведён человеком на этот адрес»: модель у такой строки не сверяется. После
// одного нажатия всё, что шлёт с того же адреса, — переадресаторы COM на одном
// лабораторном ПК, переадресатор на компьютере с Easy-Med (127.0.0.1),
// симулятор, — ложилось в добавленную строку: в лоток «другой модели», а новая
// модель так и не получала своей строки. «Добавить» меняет место прибора на
// экране, а не приём.
test('ревью C1: «Добавить» у находки не меняет, куда ложатся сообщения с того же адреса', () => {
  const db = fresh();
  const hem = ensureDevice(db, { sendingApp: 'BC-5300', peer: '127.0.0.1' }).device;
  const bio = ensureDevice(db, { sendingApp: 'BS-240', peer: '127.0.0.1' }).device;
  assert.notEqual(hem.id, bio.id);
  // Ровно то, что пишет «Добавить» (lab-devices.js, openAdopt): название и
  // added; discovered не трогается.
  db.prepare('UPDATE lab_devices SET name = ?, added = 1 WHERE id = ?').run('Гематология', hem.id);

  const again = ensureDevice(db, { sendingApp: 'BS-240', peer: '127.0.0.1' });
  assert.equal(again.created, false);
  assert.equal(again.device.id, bio.id, 'биохимия ложится в свою строку, а не в добавленную гематологию');
  const third = ensureDevice(db, { sendingApp: 'BC-20', peer: '127.0.0.1' });
  assert.equal(third.created, true, 'новая модель с того же адреса получает свою строку');
  assert.notEqual(third.device.id, hem.id);
  assert.equal(third.device.added, 0, 'и ждёт своего «Добавить»');
  assert.equal(ensureDevice(db, { sendingApp: 'BC-5300', peer: '127.0.0.1' }).device.id, hem.id, 'добавленная — по-прежнему своя строка');
  assert.equal(devices(db).length, 3);
  db.close();
});

test('ревью C1: признак «найден сам» браузер не пишет — реестр не пускает discovered в update', () => {
  assert.ok(!writableColumns('lab_devices', 'update').includes('discovered'),
    'discovered — правило приёма (ensureDevice), ставит его только сервер');
  assert.ok(writableColumns('lab_devices', 'update').includes('added'), '«Добавить» — это update added = 1');
});

// ── LIS_DISCOVERY_FIX_V1 — прибор узнаётся по адресу и по тому, КАК ОН СЕБЯ ──
// НАЗВАЛ (MSH-3 → lab_devices.sending_app, мигр. 229). Модель и название
// правит человек, и различать приборы по ним нельзя. Ревью 2026-09-29 доказало
// на настоящем ensureDevice: S1/S2 — строка без адреса глотала чужие приборы;
// S4 — два переадресатора на одном ПК сливались в одну строку; S5 — человек
// поправил модель, и следующая проба уходила в дубль.
const row = (db, id) => db.prepare('SELECT * FROM lab_devices WHERE id = ?').get(id);
/** Строка, заведённая человеком в форме «Добавить по адресу» (discovered = 0). */
function addByHand(db, { name = 'Руками', profile = '', transport = 'mllp', host = '', port = 2575, enabled = 1 } = {}) {
  return db.prepare('INSERT INTO lab_devices (name, profile, transport, host, port, enabled) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, profile, transport, host, port, enabled).lastInsertRowid;
}

test('находка запоминает, как прибор себя назвал; не назвался — имени нет', () => {
  const db = fresh();
  const out = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9', port: 2575 });
  assert.equal(out.created, true);
  assert.equal(out.device.sending_app, 'BC-5300');
  const anon = ensureDevice(db, { sendingApp: '', peer: '10.0.0.10', port: 2575 });
  assert.equal(anon.created, true);
  assert.equal(anon.device.sending_app, null, 'NULL — «не называл себя», а не пустое имя');
  db.close();
});

test('S5: человек поправил модель и название находки — следующая проба в ту же строку, дубля нет', () => {
  const db = fresh();
  // LIS_REAL_ANALYZERS_V1_MODEL — имя было «BC-2006»: с границей-цифрой оно
  // больше не BC-20 (как «BS-2000M» — не BS-200), и догадки не было бы вовсе.
  // «BC-20s» — по-прежнему BC-20: за моделью буква, а не цифра.
  const first = ensureDevice(db, { sendingApp: 'BC-20s', peer: '10.0.0.60', port: 2575 });
  assert.equal(first.device.profile, 'mindray-bc-20', 'догадка по имени — BC-20');
  // Ровно то, что пишут «Добавить» и «Изменить» с выбранной моделью.
  db.prepare("UPDATE lab_devices SET name = 'Гематология', profile = 'mindray-bc-5300', added = 1, model_confirmed = 1 WHERE id = ?").run(first.device.id);

  const next = ensureDevice(db, { sendingApp: 'BC-20s', peer: '10.0.0.60', port: 2575 });
  assert.equal(next.created, false, 'раньше здесь заводилась «BC-20s (10.0.0.60)», и панели этой строки уходили в лоток');
  assert.equal(next.device.id, first.device.id);
  assert.equal(next.reason, 'по адресу и имени');
  assert.equal(next.device.profile, 'mindray-bc-5300', 'правка человека не откатывается');
  assert.equal(devices(db).length, 1);
  db.close();
});

test('S1: строка «Кабель COM» без адреса не забирает сетевой прибор — он появляется в «Найдены в сети»', () => {
  const db = fresh();
  const com = addByHand(db, { name: 'BC-2800 (COM)', profile: 'mindray-bc-2800', transport: 'serial' });
  const out = ensureDevice(db, { sendingApp: 'BS-240', peer: '10.0.0.20', port: 2575 });
  assert.equal(out.created, true, 'сетевой BS-240 — своя находка');
  assert.notEqual(out.device.id, com);
  assert.equal(out.device.profile, 'mindray-bs-240');
  assert.equal(out.device.added, 0);
  assert.equal(row(db, com).host, '', 'строка COM не тронута');
  assert.equal(row(db, com).sending_app, null);
  db.close();
});

test('S2: строка без адреса на порту 5100 не забирает прибор, пришедший на 2575; на своём порту — забирает', () => {
  const db = fresh();
  const bio = addByHand(db, { name: 'Биохимия', profile: 'mindray-bs-240', port: 5100 });
  const out = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.30', port: 2575 });
  assert.equal(out.created, true);
  assert.notEqual(out.device.id, bio);
  assert.equal(row(db, bio).host, '', 'строка чужого порта не тронута');

  const own = ensureDevice(db, { sendingApp: 'BS-240', peer: '10.0.0.31', port: 5100 });
  assert.equal(own.device.id, bio);
  assert.equal(own.reason, 'единственный без адреса');
  db.close();
});

test('противоречащая модель не забирается; модель не угадана — не противоречие', () => {
  const db = fresh();
  const hem = addByHand(db, { name: 'Гематология', profile: 'mindray-bc-20' });
  const out = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9', port: 2575 });
  assert.equal(out.created, true, 'прибор назвался BC-5300, а строка — BC-20: это не он');
  assert.equal(row(db, hem).host, '');
  assert.equal(row(db, hem).sending_app, null);

  const unknown = ensureDevice(db, { sendingApp: 'Sysmex XN-1000', peer: '10.0.0.7', port: 2575 });
  assert.equal(unknown.created, false, 'модель по имени не угадана — возразить нечем');
  assert.equal(unknown.device.id, hem);
  db.close();
});

test('строка без адреса запоминает первого — имя и адрес — и дальше берёт только его', () => {
  const db = fresh();
  const hem = addByHand(db, { name: 'Гематология', profile: '' });
  const first = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9', port: 2575 });
  assert.equal(first.created, false);
  assert.equal(first.device.id, hem);
  assert.equal(first.device.host, '10.0.0.9', 'адрес запомнен');
  assert.equal(first.device.sending_app, 'BC-5300', 'и имя');

  const twin = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.10', port: 2575 });
  assert.equal(twin.created, true, 'второй такой же прибор — своя находка: одинаковые различает только адрес');
  const other = ensureDevice(db, { sendingApp: 'BS-240', peer: '10.0.0.9', port: 2575 });
  assert.equal(other.created, true, 'другой прибор с того же адреса — своя находка');
  assert.equal(ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9', port: 2575 }).device.id, hem, 'свой — по-прежнему в свою строку');
  assert.equal(devices(db).length, 3);
  db.close();
});

test('две свободные строки без адреса — угадывать не берёмся: находка', () => {
  const db = fresh();
  const a = addByHand(db, { name: 'Гематология 1', profile: 'mindray-bc-5300' });
  const b = addByHand(db, { name: 'Гематология 2', profile: 'mindray-bc-5300' });
  const out = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9', port: 2575 });
  assert.equal(out.created, true);
  assert.equal(row(db, a).host, '');
  assert.equal(row(db, b).host, '');
  db.close();
});

test('несколько строк без адреса: знающая имя побеждает; привязанная к другому прибору не берёт; иначе единственная свободная', () => {
  const db = fresh();
  const a = addByHand(db, { name: 'Гематология 1', profile: 'mindray-bc-5300' });
  const b = addByHand(db, { name: 'Гематология 2', profile: 'mindray-bc-5300' });
  const c = addByHand(db, { name: 'Биохимия', profile: '' });
  // Имя без адреса — ровно то, что оставляет бэкфилл мигр. 229.
  db.prepare("UPDATE lab_devices SET sending_app = 'BC-5300' WHERE id = ?").run(b);
  db.prepare("UPDATE lab_devices SET sending_app = 'BS-240' WHERE id = ?").run(c);

  const named = ensureDevice(db, { sendingApp: 'bc-5300', peer: '10.0.0.12', port: 2575 });
  assert.equal(named.device.id, b, 'имя сравнивается без учёта регистра');
  assert.equal(named.reason, 'без адреса, по имени');
  assert.equal(named.device.host, '10.0.0.12');
  assert.equal(named.device.sending_app, 'BC-5300', 'известное имя не перезаписывается');

  const free = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.13', port: 2575 });
  assert.equal(free.device.id, a, 'строка, запомнившая BS-240, чужой прибор не берёт — свободна одна');
  assert.equal(free.reason, 'единственный без адреса');

  const none = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.14', port: 2575 });
  assert.equal(none.created, true);
  assert.equal(row(db, c).host, '', 'строка BS-240 так и ждёт свой прибор');
  db.close();
});

test('выключенная строка без адреса ничего не забирает', () => {
  const db = fresh();
  const off = addByHand(db, { name: 'Гематология', profile: 'mindray-bc-5300', enabled: 0 });
  const out = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9', port: 2575 });
  assert.equal(out.created, true);
  assert.equal(row(db, off).host, '');
  db.close();
});

test('мусор строку без адреса не забирает и прибора не заводит', () => {
  // Неразобранное сообщение не назвало ни себя, ни модели; закрепить за ним
  // строку значило бы отдать её тому, кто шлёт мусор на порт.
  const db = fresh();
  const hem = addByHand(db, { name: 'Гематология', profile: 'mindray-bc-5300' });
  const out = ensureDevice(db, { sendingApp: '', peer: '10.0.0.9', port: 2575, allowCreate: false });
  assert.equal(out.device, null);
  assert.equal(row(db, hem).host, '');
  assert.equal(devices(db).length, 1);
  db.close();
});

test('S4: два переадресатора на одном ПК — две строки, и каждый дальше в свою', () => {
  const db = fresh();
  const bc = ensureDevice(db, { sendingApp: 'BC-2800', peer: '10.0.0.50', port: 2575 });
  const lumo = ensureDevice(db, { sendingApp: 'AutoLumo A1000', peer: '10.0.0.50', port: 2575 });
  assert.equal(lumo.created, true, 'раньше AutoLumo ложился в строку BC-2800 «по адресу» и не появлялся никогда');
  assert.notEqual(lumo.device.id, bc.device.id);
  // LIS_REAL_ANALYZERS_V1_MODEL — раньше '': модели AutoLumo не было. Теперь
  // «AutoLumo A1000» — модель профиля autobio-autolumo-a1000.
  assert.equal(lumo.device.profile, 'autobio-autolumo-a1000', 'переадресатор A1000 называет модель в MSH-3');

  const again = ensureDevice(db, { sendingApp: 'AutoLumo A1000', peer: '10.0.0.50', port: 2575 });
  assert.equal(again.created, false);
  assert.equal(again.device.id, lumo.device.id);
  assert.equal(ensureDevice(db, { sendingApp: ' autolumo a1000 ', peer: '10.0.0.50', port: 2575 }).device.id, lumo.device.id,
    'регистр и пробелы вокруг имени не важны');
  assert.equal(ensureDevice(db, { sendingApp: 'BC-2800', peer: '10.0.0.50', port: 2575 }).device.id, bc.device.id);
  assert.equal(devices(db).length, 2);
  db.close();
});

test('не назвался — по одному адресу; безымянному — строка без имени', () => {
  const db = fresh();
  const named = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9', port: 2575 });
  const anon = ensureDevice(db, { sendingApp: '', peer: '10.0.0.9', port: 2575 });
  assert.equal(anon.created, false);
  assert.equal(anon.device.id, named.device.id);
  assert.equal(anon.reason, 'по адресу');

  const a1 = ensureDevice(db, { sendingApp: '', peer: '10.0.0.77', port: 2575 });
  assert.equal(a1.created, true);
  const bc20 = ensureDevice(db, { sendingApp: 'BC-20', peer: '10.0.0.77', port: 2575 });
  assert.equal(bc20.created, true, 'безымянная строка с пустой моделью — не BC-20');
  assert.equal(ensureDevice(db, { sendingApp: '', peer: '10.0.0.77', port: 2575 }).device.id, a1.device.id,
    'на адресе две строки — безымянному отправителю та, что без имени');
  assert.equal(devices(db).length, 3);
  db.close();
});

test('строка человека на этом адресе запоминает первое имя; другое имя с того же адреса — находка', () => {
  const db = fresh();
  const hem = addByHand(db, { name: 'Гематология', profile: 'mindray-bc-20', host: '10.0.0.9' });
  const first = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9', port: 2575 });
  assert.equal(first.device.id, hem, 'человек сказал «по этому адресу — вот этот прибор», модель не оспариваем');
  assert.equal(first.reason, 'заведён человеком на этот адрес');
  assert.equal(first.device.sending_app, 'BC-5300');
  const other = ensureDevice(db, { sendingApp: 'BS-240', peer: '10.0.0.9', port: 2575 });
  assert.equal(other.created, true, 'за тем же адресом второй прибор — своя строка');
  assert.equal(ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9', port: 2575 }).device.id, hem);
  db.close();
});

test('найденная до мигр. 229 строка без имени — по прежнему правилу модели, и имя запоминается', () => {
  const db = fresh();
  const old = db.prepare("INSERT INTO lab_devices (name, profile, host, discovered) VALUES ('BC-5300', 'mindray-bc-5300', '10.0.0.9', 1)").run().lastInsertRowid;
  const same = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.9', port: 2575 });
  assert.equal(same.device.id, old);
  assert.equal(same.reason, 'по адресу и модели');
  assert.equal(same.device.sending_app, 'BC-5300');

  const bio = db.prepare("INSERT INTO lab_devices (name, profile, host, discovered) VALUES ('BS-240', 'mindray-bs-240', '10.0.0.20', 1)").run().lastInsertRowid;
  const differ = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.20', port: 2575 });
  assert.equal(differ.created, true, 'другая модель с того же адреса — своя строка');
  assert.equal(row(db, bio).sending_app, null, 'чужое имя строке не приписано');

  const anyModel = db.prepare("INSERT INTO lab_devices (name, profile, host, discovered) VALUES ('Анализатор 10.0.0.40', '', '10.0.0.40', 1)").run().lastInsertRowid;
  const unknown = ensureDevice(db, { sendingApp: 'Sysmex XN-1000', peer: '10.0.0.40', port: 2575 });
  assert.equal(unknown.device.id, anyModel, 'модель не угадана — верим адресу');
  assert.equal(unknown.reason, 'по адресу');
  assert.equal(unknown.device.sending_app, 'Sysmex XN-1000');
  db.close();
});

test('найденная строка без адреса узнаётся по имени, которым назвался прибор, даже переименованная', () => {
  const db = fresh();
  const id = db.prepare("INSERT INTO lab_devices (name, profile, host, discovered, sending_app) VALUES ('Гематология', 'mindray-bc-5300', '', 1, 'BC-5300')").run().lastInsertRowid;
  const out = ensureDevice(db, { sendingApp: 'bc-5300', peer: '10.0.0.9', port: 2575 });
  assert.equal(out.created, false);
  assert.equal(out.device.id, id);
  assert.equal(out.reason, 'по имени');
  assert.equal(out.device.host, '10.0.0.9', 'адрес дописан');
  assert.equal(out.device.sending_app, 'BC-5300');
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1_MODEL — модель по MSH-3 И MSH-4, псевдонимы, ──────
// граница-цифра; как прибор назвал себя в MSH-4 (sending_facility, мигр. 233).
// Различение приборов НЕ меняется: адрес и MSH-3 (LIS_DISCOVERY_FIX_V1).

test('модель — по MSH-3, потом по MSH-4: «производитель | модель» и «модель | марка»', () => {
  const key = (app, facility) => { const p = guessProfile({ app, facility }); return p ? p.key : null; };
  assert.equal(key('Mindray', 'BS-200E'), 'mindray-bs-200', 'BS-200: MSH-3 — производитель, MSH-4 — модель (руководство, с. 7–8)');
  assert.equal(key('A1000', 'Autolumo'), 'autobio-autolumo-a1000', 'Autobio по сети: модель в MSH-3');
  assert.equal(key('AutoLumo A1000', 'LabPC'), 'autobio-autolumo-a1000', 'переадресатор A1000');
  assert.equal(key('BC-780', 'Mindray'), 'mindray-bc-780');
  assert.equal(key('Mindray', 'BC-780'), 'mindray-bc-780');
  assert.equal(key('BC-780R', 'Mindray'), 'mindray-bc-780', 'псевдоним BC-780R');
  assert.equal(key('MINDRAY BC-5300', ''), 'mindray-bc-5300', 'имя с производителем — как было');
  assert.equal(key('BC-5300', 'Mindray'), 'mindray-bc-5300');
  assert.equal(key('Mindray', 'LabPC'), null, 'не узнали — null, как сегодня');
});

test('граница-цифра: «BS-2000M» — не BS-200, «BC-2006» — не BC-20; за моделью буква — узнаётся', () => {
  assert.equal(guessProfile({ app: 'BS-2000M' }), null);
  assert.equal(guessProfile({ app: 'Mindray', facility: 'BS-2000M' }), null);
  assert.equal(guessProfile('BC-2006'), null);
  assert.equal(guessProfile('Mindray BS-200E v2').key, 'mindray-bs-200');
  assert.equal(guessProfile('BC-20s').key, 'mindray-bc-20');
  assert.equal(guessProfile('A2000 Plus'), null, 'другая модель Autobio — не A1000');
});

test('точное совпадение по MSH-4 бьёт «содержит» по MSH-3', () => {
  // MSH-3 «Mindray BC-5300 LIS» содержит BC-5300, но MSH-4 называет модель
  // ровно — сначала точные совпадения по обоим полям, потом «содержит».
  assert.equal(guessProfile({ app: 'Mindray BC-5300 LIS', facility: 'BS-200E' }).key, 'mindray-bs-200');
});

test('прежняя форма guessProfile(строка MSH-3) работает как раньше', () => {
  assert.equal(guessProfile('BC-5300').key, 'mindray-bc-5300');
  assert.equal(guessProfile('Mindray'), null);
  assert.equal(guessProfile(undefined), null);
});

test('находка запоминает MSH-4 и угадывает модель по нему', () => {
  const db = fresh();
  const out = ensureDevice(db, { sendingApp: 'Mindray', sendingFacility: 'BS-200E', peer: '10.0.0.40', port: 2575 });
  assert.equal(out.created, true);
  assert.equal(out.device.sending_app, 'Mindray', 'различение — по MSH-3, как было');
  assert.equal(out.device.sending_facility, 'BS-200E');
  assert.equal(out.device.profile, 'mindray-bs-200');
  const anon = ensureDevice(db, { sendingApp: 'X', peer: '10.0.0.41', port: 2575 });
  assert.equal(anon.device.sending_facility, null, 'не назвался в MSH-4 — NULL');
  db.close();
});

test('sending_facility пишется один раз; строка без него узнаёт MSH-4 со следующей пробы', () => {
  const db = fresh();
  const first = ensureDevice(db, { sendingApp: 'Mindray', sendingFacility: 'BS-200E', peer: '10.0.0.40', port: 2575 });
  const again = ensureDevice(db, { sendingApp: 'Mindray', sendingFacility: 'BS-200', peer: '10.0.0.40', port: 2575 });
  assert.equal(again.device.id, first.device.id);
  assert.equal(again.device.sending_facility, 'BS-200E', 'запомненное не перезаписывается');

  // Строка, заведённая до мигр. 233: имя знает, MSH-4 — нет (бэкфилла нет).
  const old = db.prepare("INSERT INTO lab_devices (name, profile, host, discovered, sending_app) VALUES ('BC-5300', 'mindray-bc-5300', '10.0.0.9', 1, 'BC-5300')").run().lastInsertRowid;
  const next = ensureDevice(db, { sendingApp: 'BC-5300', sendingFacility: 'Mindray', peer: '10.0.0.9', port: 2575 });
  assert.equal(next.device.id, old);
  assert.equal(next.reason, 'по адресу и имени');
  assert.equal(next.device.sending_facility, 'Mindray');
  db.close();
});

test('две строки за одним адресом с разными MSH-3 различаются, как было; MSH-4 в различении не участвует', () => {
  const db = fresh();
  const bs = ensureDevice(db, { sendingApp: 'Mindray', sendingFacility: 'BS-200E', peer: '10.0.0.50', port: 2575 });
  const lumo = ensureDevice(db, { sendingApp: 'A1000', sendingFacility: 'Autolumo', peer: '10.0.0.50', port: 2575 });
  assert.equal(lumo.created, true);
  assert.notEqual(lumo.device.id, bs.device.id);
  assert.equal(ensureDevice(db, { sendingApp: 'Mindray', sendingFacility: 'другое', peer: '10.0.0.50', port: 2575 }).device.id, bs.device.id,
    'тот же MSH-3 с того же адреса — та же строка, что бы ни было в MSH-4');
  assert.equal(devices(db).length, 2);
  db.close();
});

test('строка без адреса с моделью BS-240 не забирает BS-200 (раньше его модель не угадывалась)', () => {
  const db = fresh();
  const bs240 = addByHand(db, { name: 'Биохимия', profile: 'mindray-bs-240' });
  const out = ensureDevice(db, { sendingApp: 'Mindray', sendingFacility: 'BS-200E', peer: '10.0.0.40', port: 2575 });
  assert.equal(out.created, true, 'модель BS-200 противоречит строке BS-240 — своя находка');
  assert.equal(out.device.profile, 'mindray-bs-200');
  assert.equal(row(db, bs240).host, '');
  assert.equal(row(db, bs240).sending_app, null);
  db.close();
});
