// records.test.js — BRANCH_RECORDS_V1: приём чужих изменений.
//
// Здесь живут решения, которые нельзя переиграть после того, как данные
// разъехались: что побеждает при конфликте, что делать со ссылкой на строку,
// которая ещё не приехала, и почему удаление проигрывает более поздней правке.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { applyBatch } from './records.js';
import { SHIPPED, buildBatch, markSent } from './journal.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('DELETE FROM sync_journal').run();
  return db;
}
const S = { self: 'B' };
// Метка от РЕАЛЬНОГО времени. С Задачи 7d спор решает время правки, а с 7e
// местное авторство хранится в sync_authored и переживает чистку журнала —
// поэтому синтетическая метка «девять миллисекунд от 1970 года» честно
// проигрывает любому здешнему касанию строки, включая выданный ей номер карты.
const stampAt = (ms, node = 'C', cnt = 0) =>
  Math.floor(ms).toString(16).padStart(12, '0') + '-' + cnt.toString(16).padStart(4, '0') + '-' + node;
const T0 = Date.now() - 24 * 3600000;   // «сутки назад» — старше всего местного
const put = (tbl, uid, stamp, data, refs = {}) => ({ tbl, uid, op: 'put', stamp, data, refs, origin: 'C' });
const del = (tbl, uid, stamp) => ({ tbl, uid, op: 'del', stamp, origin: 'C' });

test('новый пациент приезжает и заводится под СВОИМ локальным id', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Местный')").run();   // занимаем id=1
  applyBatch(db, [put('patients', 'aaaa', '000000000001-0000-C', { full_name: 'Приезжий', phone: '+998900000001' })], S);
  const row = db.prepare("SELECT id, full_name FROM patients WHERE uid = 'aaaa'").get();
  assert.equal(row.full_name, 'Приезжий');
  assert.notEqual(row.id, 1, 'локальные id не переносятся: они уже заняты');
  db.close();
});

test('поколоночное слияние: телефон там, адрес здесь — выживают оба', () => {
  const db = fresh();
  applyBatch(db, [put('patients', 'bbbb', '000000000001-0000-C', { full_name: 'Иванов', phone: '+998900000001', address: '' })], S);
  // Здесь правят адрес — и ЭТА правка уже уехала соседу C (журнал пуст, sent_seq выше).
  db.prepare("UPDATE patients SET address = 'Ташкент' WHERE uid = 'bbbb'").run();
  const top = db.prepare('SELECT MAX(seq) AS s FROM sync_journal').get().s;
  db.prepare("INSERT INTO sync_peers (node, sent_seq, last_ok) VALUES ('C', ?, ?)").run(top, new Date().toISOString());
  // Оттуда приезжает правка телефона с БОЛЕЕ ПОЗДНЕЙ меткой, без адреса.
  applyBatch(db, [put('patients', 'bbbb', '000000000009-0000-C', { phone: '+998900000002' })], S);
  const row = db.prepare("SELECT phone, address FROM patients WHERE uid = 'bbbb'").get();
  assert.equal(row.phone, '+998900000002', 'приехавшая правка применилась');
  assert.equal(row.address, 'Ташкент', 'и не стёрла то, чего в ней не было');
  db.close();
});

test('приехавшая запись не стирает местную НЕОТПРАВЛЕННУЮ правку', () => {
  const db = fresh();
  applyBatch(db, [put('patients', 'eeee', '000000000001-0000-C', { full_name: 'Иванов', phone: '+998900000001' })], S);
  db.prepare("UPDATE patients SET phone = '+998900000009' WHERE uid = 'eeee'").run();   // соседу C ещё не отправлено
  applyBatch(db, [put('patients', 'eeee', '000000000005-0000-C', { full_name: 'Иванов', phone: '+998900000001' })], S);
  assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'eeee'").get().phone, '+998900000009',
    'неотправленная местная правка новее любой приехавшей');
  db.close();
});

test('ссылка на ещё не приехавшего родителя ждёт и потом применяется', () => {
  const db = fresh();
  const r1 = applyBatch(db, [put('visits', 'v1', '000000000001-0000-C', { visit_date: '2026-09-02', status: 'scheduled' }, { patient_id: 'p1' })], S);
  assert.equal(r1.deferred, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM visits WHERE uid = 'v1'").get().n, 0, 'NOT NULL: ребёнка без родителя вставить нельзя — он ждёт');
  assert.equal(db.prepare("SELECT waits_uid FROM sync_pending WHERE uid = 'v1'").get().waits_uid, 'p1');
  applyBatch(db, [put('patients', 'p1', '000000000002-0000-C', { full_name: 'Опоздавший' })], S);
  const v = db.prepare("SELECT patient_id FROM visits WHERE uid = 'v1'").get();
  const p = db.prepare("SELECT id FROM patients WHERE uid = 'p1'").get();
  assert.equal(v.patient_id, p.id, 'ребёнок применился, когда родитель приехал');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_pending').get().n, 0, 'и вышел из ожидания');
  db.close();
});

test('двое детей ждут разных родителей и получают именно своих', () => {
  const db = fresh();
  applyBatch(db, [
    put('visits', 'vA', '000000000001-0000-C', { visit_date: '2026-09-01', status: 'scheduled' }, { patient_id: 'pA' }),
    put('visits', 'vB', '000000000002-0000-C', { visit_date: '2026-09-02', status: 'scheduled' }, { patient_id: 'pB' }),
  ], S);
  applyBatch(db, [
    put('patients', 'pA', '000000000003-0000-C', { full_name: 'А' }),
    put('patients', 'pB', '000000000004-0000-C', { full_name: 'Б' }),
  ], S);
  const pa = db.prepare("SELECT id FROM patients WHERE uid = 'pA'").get().id;
  const pb = db.prepare("SELECT id FROM patients WHERE uid = 'pB'").get().id;
  assert.equal(db.prepare("SELECT patient_id FROM visits WHERE uid = 'vA'").get().patient_id, pa);
  assert.equal(db.prepare("SELECT patient_id FROM visits WHERE uid = 'vB'").get().patient_id, pb, 'перепутать родителей хуже, чем не связать вовсе');
  db.close();
});

test('цепочка визит → услуга → результат ждёт и освобождается до неподвижной точки', () => {
  const db = fresh();
  const sid = db.prepare("INSERT INTO services (name, code, price, type, active) VALUES ('ОАК','S-1',1000,'lab',1)").run().lastInsertRowid;
  // Приезжают в обратном порядке: результат, услуга, визит, пациент.
  applyBatch(db, [put('lab_results', 'r1', '000000000001-0000-C', { value: '5.2' }, { visit_service_id: 's1' })], S);
  applyBatch(db, [put('visit_services', 's1', '000000000002-0000-C', { quantity: 1, status: 'ordered', service_id: sid }, { visit_id: 'v1' })], S);
  applyBatch(db, [put('visits', 'v1', '000000000003-0000-C', { visit_date: '2026-09-02', status: 'scheduled' }, { patient_id: 'p1' })], S);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_pending').get().n, 3, 'все трое ждут');
  applyBatch(db, [put('patients', 'p1', '000000000004-0000-C', { full_name: 'И' })], S);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_pending').get().n, 0, 'один родитель освободил всю цепочку');
  assert.equal(db.prepare("SELECT value FROM lab_results WHERE uid = 'r1'").get().value, '5.2');
  db.close();
});

test('удаление проигрывает более поздней правке', () => {
  const db = fresh();
  applyBatch(db, [put('patients', 'cccc', '000000000001-0000-C', { full_name: 'Иванов' })], S);
  db.prepare("UPDATE patients SET full_name = 'Иванов-Петров' WHERE uid = 'cccc'").run();   // местная, неотправленная
  applyBatch(db, [del('patients', 'cccc', '000000000000-0000-C')], S);
  const row = db.prepare("SELECT full_name FROM patients WHERE uid = 'cccc'").get();
  assert.ok(row, 'молча уничтожать запись, с которой кто-то работал, нельзя');
  assert.equal(row.full_name, 'Иванов-Петров');
  db.close();
});

test('запоздавший put не воскрешает удалённую строку', () => {
  const db = fresh();
  applyBatch(db, [put('patients', 'tttt', stampAt(T0), { full_name: 'Иванов' })], S);
  // Удаление ПОЗЖЕ всего здешнего: номер карты этой строке выдали тут же, при
  // приёме, и это — местное авторство колонки mrn. Удаление из 1970 года
  // проиграло бы ему, и правильно: строку, которую здесь только что трогали,
  // не сносят меткой из прошлого.
  applyBatch(db, [del('patients', 'tttt', stampAt(Date.now() + 60000))], S);
  applyBatch(db, [put('patients', 'tttt', stampAt(T0 + 1000), { full_name: 'Иванов' })], S);   // собран ДО удаления
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patients WHERE uid = 'tttt'").get().n, 0, 'отправитель удаление не повторит — воскрешение было бы навсегда');
  // А put НОВЕЕ надгробия — законное повторное заведение.
  applyBatch(db, [put('patients', 'tttt', stampAt(Date.now() + 120000), { full_name: 'Иванов снова' })], S);
  assert.equal(db.prepare("SELECT full_name FROM patients WHERE uid = 'tttt'").get().full_name, 'Иванов снова');
  db.close();
});

test('своё же изменение, вернувшееся обратно, ничего не портит', () => {
  const db = fresh();
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  const uid = db.prepare('SELECT uid FROM patients WHERE id = ?').get(id).uid;
  const top = db.prepare('SELECT MAX(seq) AS s FROM sync_journal').get().s;
  db.prepare("INSERT INTO sync_peers (node, sent_seq, last_ok) VALUES ('C', ?, ?)").run(top, new Date().toISOString());
  const before = db.prepare('SELECT COUNT(*) n FROM patients').get().n;
  applyBatch(db, [put('patients', uid, '000000000001-0000-C', { full_name: 'Иванов' })], S);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patients').get().n, before, 'дубля не появилось');
  db.close();
});

test('приём НЕ пишет в журнал: иначе изменения ходили бы по кругу вечно', () => {
  const db = fresh();
  applyBatch(db, [put('patients', 'dddd', '000000000001-0000-C', { full_name: 'Приезжий' })], S);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_journal WHERE uid = 'dddd'").get().n, 0);
  db.close();
});

test('запись без метки пропускается, а не роняет всю порцию', () => {
  const db = fresh();
  const r = applyBatch(db, [
    { tbl: 'patients', uid: 'zzzz', op: 'put', data: { full_name: 'Без метки' }, refs: {}, origin: 'C' },
    put('patients', 'yyyy', '000000000001-0000-C', { full_name: 'С меткой' }),
  ], S);
  assert.equal(r.skipped, 1);
  assert.equal(r.applied, 1, 'вторая запись применилась, транзакция не упала');
  db.close();
});

test('приём двигает часы за самую новую чужую метку', () => {
  const db = fresh();
  applyBatch(db, [put('patients', 'kkkk', '0000000fffff-0003-C', { full_name: 'Из будущего' })], S);
  const clock = db.prepare("SELECT value FROM control_state WHERE key = 'sync_clock'").get();
  assert.ok(clock, 'часы записаны');
  assert.equal(JSON.parse(clock.value).ms >= 0xfffff, true, 'узел с отставшими часами перестаёт проигрывать');
  db.close();
});

test('без self приём отказывается работать', () => {
  const db = fresh();
  assert.throws(() => applyBatch(db, [put('patients', 'qqqq', '000000000001-0000-C', { full_name: 'X' })], {}), /self/);
  db.close();
});

// Услуга приезжает по КОДУ из справочника, а не по локальному id: services
// синхронизирует catalogue.js, и id одной и той же услуги в двух филиалах
// разный. Пока кода нет в местном справочнике, строка ждёт — привязать
// лабораторную работу к ЧУЖОЙ услуге хуже, чем подождать.
test('услуга с неизвестным местным кодом ждёт справочник и садится на местный id', () => {
  const db = fresh();
  applyBatch(db, [put('patients', 'p9', '000000000001-0000-C', { full_name: 'И' })], S);
  applyBatch(db, [put('visits', 'v9', '000000000002-0000-C', { visit_date: '2026-09-02', status: 'scheduled' }, { patient_id: 'p9' })], S);
  const r = applyBatch(db, [put('visit_services', 's9', '000000000003-0000-C',
    { quantity: 1, status: 'ordered' }, { visit_id: 'v9', service_code: 'S-НЕТ' })], S);
  assert.equal(r.deferred, 1, 'родитель-визит на месте, а услуги в справочнике нет — ждём её');
  const w = db.prepare("SELECT waits_tbl, waits_uid FROM sync_pending WHERE uid = 's9'").get();
  assert.equal(w.waits_tbl, 'services');
  assert.equal(w.waits_uid, 'S-НЕТ');
  // Справочник доезжает позже (catalogue.js) — и ожидание разбирается само.
  const sid = db.prepare("INSERT INTO services (name, code, price, type, active) VALUES ('ОАК','S-НЕТ',1000,'lab',1)").run().lastInsertRowid;
  applyBatch(db, [], S);
  assert.equal(db.prepare("SELECT service_id FROM visit_services WHERE uid = 's9'").get().service_id, sid,
    'услуга села на МЕСТНЫЙ id по коду');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_pending').get().n, 0);
  db.close();
});

// Защита местной правки — на ВСЮ строку, включая ссылки. Отдельным тестом,
// потому что первая реализация защищала только поля из SHIPPED: приехавшая
// запись оставляла статус в покое, но перевешивала визит на другого пациента.
test('7e: ссылку держит МЕТКА, а не защита — визит не перевешивают на другого пациента', () => {
  const db = fresh();
  applyBatch(db, [
    put('patients', 'pX', stampAt(T0), { full_name: 'Первый' }),
    put('patients', 'pY', stampAt(T0), { full_name: 'Второй' }),
    put('visits', 'vX', stampAt(T0), { visit_date: '2026-09-01', status: 'scheduled' }, { patient_id: 'pX' }),
  ], S);
  const px = db.prepare("SELECT id FROM patients WHERE uid = 'pX'").get().id;
  db.prepare("UPDATE visits SET status = 'arrived' WHERE uid = 'vX'").run();   // здешняя правка, только что

  // Приехавшая запись СТАРШЕ и поля, и ссылки — устоять обязаны обе. Раньше их
  // держала защита «неотправленного», теперь — метка правки, и работает она
  // независимо от того, выложились мы соседу или ещё нет.
  applyBatch(db, [put('visits', 'vX', stampAt(T0 - 1000),
    { visit_date: '2026-09-01', status: 'scheduled' }, { patient_id: 'pY' })], S);
  const v = db.prepare("SELECT patient_id, status FROM visits WHERE uid = 'vX'").get();
  assert.equal(v.status, 'arrived', 'поле новее приехавшего');
  assert.equal(v.patient_id, px, 'перевесить визит на ДРУГОГО пациента не лучше, чем стереть телефон');

  // А ссылка, которую сосед вправду переставил ПОЗЖЕ, применяется: это уже не
  // «перевесить исподтишка», а его законная правка.
  applyBatch(db, [put('visits', 'vX', stampAt(Date.now() + 60000),
    { visit_date: '2026-09-01', status: 'scheduled' }, { patient_id: 'pY' })], S);
  assert.equal(db.prepare("SELECT patient_id FROM visits WHERE uid = 'vX'").get().patient_id,
    db.prepare("SELECT id FROM patients WHERE uid = 'pY'").get().id,
    'иначе визит навсегда остался бы у не того пациента');
  db.close();
});

// ССЫЛКА — ТАКАЯ ЖЕ КОЛОНКА. Три теста ниже — про один и тот же промах первой
// реализации: поколоночное правило применялось к полям из SHIPPED, а
// разрешённые ссылки (patient_id, visit_id, visit_service_id, service_id)
// клались в UPDATE безусловно. Визит молча переезжал к другому пациенту —
// в карте это не «конфликт слияния», это чужая история болезни.
test('приехавшая СТАРАЯ ссылка не перевешивает визит', () => {
  const db = fresh();
  applyBatch(db, [
    put('patients', 'pA2', '000000000001-0000-C', { full_name: 'А' }),
    put('patients', 'pB2', '000000000002-0000-C', { full_name: 'Б' }),
    put('visits', 'v2', '000000000007-0000-C', { visit_date: '2026-09-02', status: 'scheduled' }, { patient_id: 'pA2' }),
  ], S);
  const pa = db.prepare("SELECT id FROM patients WHERE uid = 'pA2'").get().id;
  // Та же строка, метка СТАРШЕ принятой, ссылка — на другого пациента.
  applyBatch(db, [put('visits', 'v2', '000000000003-0000-C', {}, { patient_id: 'pB2' })], S);
  assert.equal(db.prepare("SELECT patient_id FROM visits WHERE uid = 'v2'").get().patient_id, pa,
    'ссылка принята под более новой меткой — старая её не отменяет');
  db.close();
});

test('ожидание, перекрытое более новой записью, снимается, а не ждёт своего часа', () => {
  const db = fresh();
  applyBatch(db, [put('patients', 'pZ', '000000000004-0000-C', { full_name: 'Есть' })], S);
  const r = applyBatch(db, [put('visits', 'vZ', '000000000001-0000-C',
    { visit_date: '2026-09-01', status: 'scheduled' }, { patient_id: 'pПРОПАЛ' })], S);
  assert.equal(r.deferred, 1);
  applyBatch(db, [put('visits', 'vZ', '000000000003-0000-C',
    { visit_date: '2026-09-02', status: 'arrived' }, { patient_id: 'pZ' })], S);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_pending WHERE uid = 'vZ'").get().n, 0,
    'хранить заведомо проигравшую запись — значит проигрывать её заново каждую порцию');
  db.close();
});

test('опоздавший родитель не воспроизводит устаревшее ожидание поверх нового состояния', () => {
  const db = fresh();
  applyBatch(db, [put('patients', 'pNEW', '000000000004-0000-C', { full_name: 'Новый' })], S);
  // Запись S1 приезжает первой и ложится ждать pOLD.
  applyBatch(db, [put('visits', 'v1', '000000000001-0000-C',
    { visit_date: '2026-09-01', status: 'scheduled' }, { patient_id: 'pOLD' })], S);
  // Более новая запись S3 про ТОТ ЖЕ визит применяется напрямую: её родитель на месте.
  applyBatch(db, [put('visits', 'v1', '000000000003-0000-C',
    { visit_date: '2026-09-02', status: 'arrived' }, { patient_id: 'pNEW' })], S);
  const pnew = db.prepare("SELECT id FROM patients WHERE uid = 'pNEW'").get().id;
  // Родитель устаревшей записи доезжает последним.
  applyBatch(db, [put('patients', 'pOLD', '000000000005-0000-C', { full_name: 'Старый' })], S);
  const v = db.prepare("SELECT patient_id, status, visit_date FROM visits WHERE uid = 'v1'").get();
  assert.equal(v.patient_id, pnew, 'визит остаётся у того пациента, к которому его привязали новее');
  assert.equal(v.status, 'arrived', 'и не разъезжается: статус от одной записи, ссылка от другой');
  assert.equal(v.visit_date, '2026-09-02');
  db.close();
});

// BRANCH_ORIGIN_V1 — «откуда запись». Хранимая метка, а не буква MRN: MRN
// говорит, где пациент ЗАВЕДЁН, а рабочие списки спрашивают, где сделана
// РАБОТА. Ставится при вставке и больше никогда — иначе правка соседа
// перекрашивала бы чужую строку в свою и обратно.
test('приехавшая строка помечена буквой соседа, местная — ничем, и правка метку не меняет', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Местный')").run();
  applyBatch(db, [put('patients', 'oo1', '000000000001-0000-C', { full_name: 'Приезжий', phone: '+998900000001' })], S);

  assert.equal(db.prepare("SELECT sync_origin FROM patients WHERE uid = 'oo1'").get().sync_origin, 'C',
    'строка приехала из C — очередь и кабинет врача не должны считать её своей работой');
  assert.equal(db.prepare("SELECT sync_origin FROM patients WHERE full_name = 'Местный'").get().sync_origin, null,
    'заведённое здесь не помечается ничем: NULL и есть «своё здание»');

  // Та же строка правится в C ещё раз. Происхождение — факт, а не состояние.
  applyBatch(db, [put('patients', 'oo1', '000000000009-0000-C', { phone: '+998900000002' })], S);
  const row = db.prepare("SELECT phone, sync_origin FROM patients WHERE uid = 'oo1'").get();
  assert.equal(row.phone, '+998900000002', 'правка применилась');
  assert.equal(row.sync_origin, 'C', 'и не переписала происхождение');

  // Буква берётся из МЕТКИ, а не из поля origin: origin отправитель заполняет
  // сам, а метка проверена isStamp. Запись без origin всё равно подписана
  // правильно, а запись, назвавшаяся чужим именем, — своей настоящей буквой.
  applyBatch(db, [{ tbl: 'patients', uid: 'oo2', op: 'put', stamp: '000000000002-0000-C', data: { full_name: 'Безымянный' }, refs: {} }], S);
  assert.equal(db.prepare("SELECT sync_origin FROM patients WHERE uid = 'oo2'").get().sync_origin, 'C',
    'метка знает узел — поле origin для этого не нужно');
  // А вот запись, у которой origin и метка называют РАЗНЫЕ узлы, не
  // применяется вовсе (ревью 7/7b, M1). Раньше она применялась, а буква
  // бралась из метки — «в колонку не попадает то, что прислали в поле».
  // Оказалось, что этого мало: origin решает, ЧЬЮ защиту снимать при слиянии
  // (localUnshippedCols), а метка — чьей буквой подписать строку. Разойдись
  // они, и строка садится в базу подписанной одним филиалом, а слитой по
  // правилам другого; на карточке пациента подпись указывает не туда, и
  // проверить это владельцу нечем. Две разные личности в одной записи — это
  // сломанная сборка или подделка, и место такой записи не в базе.
  const forged = applyBatch(db, [{ tbl: 'patients', uid: 'oo4', op: 'put', stamp: '000000000003-0000-D', data: { full_name: 'Из D' }, refs: {}, origin: 'ПОДДЕЛКА' }], S);
  assert.equal(forged.skipped, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patients WHERE uid = 'oo4'").get().n, 0,
    'запись, называющая себя двумя разными узлами сразу, не применяется вовсе');
  db.close();
});

test('метка происхождения не уезжает обратно: у соседа своя точка зрения', () => {
  for (const tbl of Object.keys(SHIPPED)) {
    assert.ok(!SHIPPED[tbl].includes('sync_origin'),
      tbl + ': отправив метку, B объявил бы C, что собственные строки C — чужие');
  }
});

// --- ревью Задачи 5: поколоночное слияние по-настоящему ---
//
// Этот блок про один дефект и его цену. Отправитель отдавал СНИМОК всей строки
// под ОДНОЙ меткой, приёмник записывал эту метку КАЖДОЙ колонке снимка, а
// местная неотправленная правка защищалась ОТБРАСЫВАНИЕМ всей приехавшей
// записи. Три решения вместе теряли данные, хотя каждое по отдельности
// выглядело осторожным.

// ГЛАВНЫЙ ИНВАРИАНТ ФАЗЫ. Настоящий обмен двух узлов, без ручных записей: B и C
// — две базы, порции собирает buildBatch, применяет applyBatch, отметку двигает
// markSent. B правит телефон, C — адрес, ни одна правка ещё не отдана.
//
// Как это ломалось раньше: B→C — C видит местную неотправленную правку и
// ОТБРАСЫВАЕТ запись B целиком, а markSent у B уже сдвинулся, и телефон больше
// никогда не уедет. C→B — снимок C несёт ПУСТОЙ телефон под меткой новее, и
// номер стирается у B. Итог: {phone: '', address: 'Ташкент'} на обеих сторонах,
// телефон исчез из сети целиком. Не «конфликт слияния» — потеря данных.
test('ДВА УЗЛА: телефон из B и адрес из C, оба неотправленные, выживают у ОБОИХ', () => {
  const B = fresh();
  const C = fresh();

  // Пациент заводится в B и уезжает в C холодным засевом.
  B.prepare("INSERT INTO patients (full_name, phone, address) VALUES ('Иванов', '', '')").run();
  const seed = buildBatch(B, { self: 'B', peer: 'C' });
  applyBatch(C, seed.records, { self: 'C', peer: 'B' });
  markSent(B, 'C', seed.upto, seed.clock, seed.seed);
  assert.equal(seed.seed.done, true, 'один пациент помещается в одну страницу засева');

  // C тоже считает B тёплым: без строки в sync_peers ЛЮБАЯ местная правка C
  // защищалась бы целиком, и тест проверял бы не то.
  C.prepare(`INSERT INTO sync_peers (node, sent_seq, last_ok)
             VALUES ('B', (SELECT COALESCE(MAX(seq), 0) FROM sync_journal), ?)`)
    .run(new Date().toISOString());

  const uid = B.prepare('SELECT uid FROM patients').get().uid;
  B.prepare("UPDATE patients SET phone = '+998901112233' WHERE uid = ?").run(uid);
  C.prepare("UPDATE patients SET address = 'Ташкент' WHERE uid = ?").run(uid);

  const b2c = buildBatch(B, { self: 'B', peer: 'C' });
  assert.deepEqual(b2c.records.map(r => r.changed), [['phone']], 'B правил только телефон');
  applyBatch(C, b2c.records, { self: 'C', peer: 'B' });
  markSent(B, 'C', b2c.upto, b2c.clock, b2c.seed);   // отправлено — второй раз не приедет

  const c2b = buildBatch(C, { self: 'C', peer: 'B' });
  assert.deepEqual(c2b.records.map(r => r.changed), [['address']], 'C правил только адрес');
  applyBatch(B, c2b.records, { self: 'B', peer: 'C' });
  markSent(C, 'B', c2b.upto, c2b.clock, c2b.seed);

  const inB = B.prepare('SELECT phone, address FROM patients WHERE uid = ?').get(uid);
  const inC = C.prepare('SELECT phone, address FROM patients WHERE uid = ?').get(uid);
  assert.deepEqual(inB, { phone: '+998901112233', address: 'Ташкент' }, 'у B');
  assert.deepEqual(inC, { phone: '+998901112233', address: 'Ташкент' }, 'у C');
  B.close(); C.close();
});

// Проверка формы записи ловит мусор, но не ловит отказ САМОЙ БАЗЫ: CHECK,
// внешний ключ, длину поля. Без savepoint такой отказ уносил бы всю порцию.
test('запись, которую отвергает база, пропускается поимённо — соседние применяются', () => {
  const db = fresh();
  const r = applyBatch(db, [
    put('patients', 'ph1', '000000000001-0000-C', { full_name: 'Первый' }),
    // status вне CHECK (003_visits.sql) — база откажет уже на вставке
    put('visits', 'vBAD', '000000000002-0000-C', { visit_date: '2026-09-02', status: 'completed' }, { patient_id: 'ph1' }),
    put('patients', 'ph2', '000000000003-0000-C', { full_name: 'Второй' }),
  ], S);
  assert.equal(r.skipped, 1, 'кривая — одна');
  assert.equal(r.applied, 2, 'обе здоровые применились: транзакция не потеряна');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patients WHERE uid IN ('ph1','ph2')").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM visits WHERE uid = 'vBAD'").get().n, 0, 'и откатилась целиком');
  db.close();
});

test('нескалярное значение в данных — пропуск по имени, а не падение', () => {
  const db = fresh();
  const r = applyBatch(db, [
    { tbl: 'patients', uid: 'bad1', op: 'put', stamp: '000000000001-0000-C',
      data: { full_name: 'Кривой', active: true }, refs: {}, origin: 'C' },
    { tbl: 'patients', uid: 'bad2', op: 'put', stamp: '000000000002-0000-C',
      data: { full_name: { ru: 'Объект' } }, refs: {}, origin: 'C' },
    put('patients', 'good1', '000000000003-0000-C', { full_name: 'Нормальный' }),
  ], S);
  assert.equal(r.skipped, 2);
  assert.equal(r.applied, 1);
  assert.equal(db.prepare("SELECT full_name FROM patients WHERE uid = 'good1'").get().full_name, 'Нормальный');
  db.close();
});

// Защита — по колонкам, а не по строке. Раньше здесь отбрасывалась вся запись,
// и правка отправителя пропадала навсегда: он-то свой markSent уже сдвинул.
test('7e: поколоночность без защиты — чужая колонка применяется, своя более свежая остаётся', () => {
  const db = fresh();
  applyBatch(db, [put('patients', 'pc1', stampAt(T0),
    { full_name: 'Иванов', phone: '+998900000001', address: '' })], S);
  db.prepare("INSERT INTO sync_peers (node, sent_seq, last_ok) VALUES ('C', 0, ?)").run(new Date().toISOString());
  editAgo(db, 5, "UPDATE patients SET phone = '+998909999999' WHERE uid = 'pc1'");   // здешняя, 5 минут назад

  const r1 = applyBatch(db, [{
    ...put('patients', 'pc1', stampAt(Date.now() - 60000), { phone: '+998900000002', address: 'Ташкент' }),
    changed: ['address'], stamps: { address: stampAt(Date.now() - 60000, 'C') },
  }], S);
  const after1 = db.prepare("SELECT phone, address FROM patients WHERE uid = 'pc1'").get();
  assert.equal(after1.address, 'Ташкент', 'адрес — авторская колонка соседа, применяется');
  assert.equal(after1.phone, '+998909999999', 'телефон в снимке — его копия нашего старого значения, не правка');
  assert.equal(r1.applied, 1);

  // Сосед объявляет своим и телефон, но правил он его РАНЬШЕ нас.
  const r2 = applyBatch(db, [{
    ...put('patients', 'pc1', stampAt(Date.now() - 30000), { phone: '+998900000003', address: 'Самарканд' }),
    changed: ['phone', 'address'],
    stamps: { phone: stampAt(Date.now() - 600000, 'C'), address: stampAt(Date.now() - 30000, 'C') },
  }], S);
  const after2 = db.prepare("SELECT phone, address FROM patients WHERE uid = 'pc1'").get();
  assert.equal(after2.address, 'Самарканд', 'адрес применился: сосед правил его позже');
  assert.equal(after2.phone, '+998909999999', 'а телефон остался наш: мы правили его позже');
  assert.equal(r2.applied, 1, 'запись НЕ отброшена целиком: так и терялись правки');
  db.close();
});

// origin приходит из порции, подписи у него нет. Но вызывающий знает, ЧЕЙ блоб
// он забрал, и запись с чужой буквой в этом блобе — либо ошибка сборки, либо
// попытка выдать себя за третий филиал: origin решает, чью защиту снимать.
test('peer задан — запись с чужим origin не применяется', () => {
  const db = fresh();
  const r = applyBatch(db, [
    put('patients', 'pp1', '000000000001-0000-C', { full_name: 'От C' }),          // origin: 'C'
    { ...put('patients', 'pp2', '000000000002-0000-C', { full_name: 'Якобы от D' }), origin: 'D' },
  ], { self: 'B', peer: 'C' });
  assert.equal(r.applied, 1);
  assert.equal(r.skipped, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patients WHERE uid = 'pp2'").get().n, 0);
  // Без peer сверять origin не с чем — зато есть метка (ревью 7/7b, M1):
  // запись, у которой origin и метка называют разные узлы, не применяется и
  // здесь. Раньше она проезжала.
  applyBatch(db, [{ ...put('patients', 'pp2', '000000000003-0000-C', { full_name: 'Якобы от D' }), origin: 'D' }], S);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patients WHERE uid = 'pp2'").get().n, 0);
  // А согласная сама с собой — применяется, как и applyBatch без peer вообще.
  applyBatch(db, [put('patients', 'pp3', '000000000004-0000-C', { full_name: 'Честная от C' })], S);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patients WHERE uid = 'pp3'").get().n, 1);
  db.close();
});

test('deferred — сколько ЖДЁТ на конец порции; released — сколько разобрано из ожидания', () => {
  const db = fresh();
  db.prepare("INSERT INTO services (name, code, price, type, active) VALUES ('ОАК','S-1',1000,'lab',1)").run();
  // Задом наперёд, одной порцией: родитель приезжает последним.
  const r = applyBatch(db, [
    put('lab_results', 'r1', '000000000001-0000-C', { value: '5.2' }, { visit_service_id: 's1' }),
    put('visit_services', 's1', '000000000002-0000-C', { quantity: 1, status: 'ordered' }, { visit_id: 'v1', service_code: 'S-1' }),
    put('visits', 'v1', '000000000003-0000-C', { visit_date: '2026-09-02', status: 'scheduled' }, { patient_id: 'p1' }),
    put('patients', 'p1', '000000000004-0000-C', { full_name: 'И' }),
  ], S);
  assert.equal(r.deferred, 0, 'к концу транзакции не ждёт никто — «отложено 3 раза» сбивало бы с толку');
  assert.equal(r.released, 3, 'цепочка разобрана из ожидания в этой же порции');
  assert.equal(r.applied, 4);
  assert.equal(db.prepare("SELECT value FROM lab_results WHERE uid = 'r1'").get().value, '5.2');

  // А вот запись, чей родитель так и не приехал, в отчёте остаётся.
  const r2 = applyBatch(db, [put('visits', 'vX', '000000000005-0000-C',
    { visit_date: '2026-09-03', status: 'scheduled' }, { patient_id: 'pНЕТ' })], S);
  assert.equal(r2.deferred, 1);
  assert.equal(r2.released, 0);
  db.close();
});

// --- Задача 7b: подтверждённая доставка -------------------------------------
//
// Защита местной неотправленной правки читает теперь pub_seq («выложено»), а
// не sent_seq («подтверждено соседом»). Разница в одну колонку, а решает она
// всё: подтверждение отстаёт от выгрузки на такт, и держи защита строку до
// него — B не принимал бы адрес от C, C не принимал бы телефон от B, и оба
// узла не сошлись бы вовсе (пробная сборка Задачи 7, воспроизведено).

// Здесь стоял тест «выгрузка снимает защиту». Защиты больше нет вовсе
// (Задача 7e): и до выгрузки, и после спор решает одно и то же — чья правка
// колонки позже. Это и проверяем: результат не зависит от того, успели мы
// выложиться соседу или ещё нет.
test('7e: исход не зависит от того, выложились мы соседу или нет', () => {
  for (const published of [false, true]) {
    const db = fresh();
    applyBatch(db, [put('patients', 'sh1', stampAt(T0),
      { full_name: 'Иванов', phone: '+998900000001' })], S);
    db.prepare("INSERT INTO sync_peers (node, pub_seq, sent_seq, last_ok) VALUES ('C', 0, 0, ?)")
      .run(new Date().toISOString());
    editAgo(db, 10, "UPDATE patients SET phone = 'моё' WHERE uid = 'sh1'");
    if (published) {
      db.prepare('UPDATE sync_peers SET pub_seq = (SELECT MAX(seq) FROM sync_journal) WHERE node = ?').run('C');
    }

    applyBatch(db, [{
      ...put('patients', 'sh1', stampAt(Date.now() - 3600000), { phone: 'соседское старое' }),
      changed: ['phone'], stamps: { phone: stampAt(Date.now() - 3600000, 'C') },
    }], S);
    assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'sh1'").get().phone, 'моё',
      'выложено=' + published + ': своя более поздняя правка остаётся');

    applyBatch(db, [{
      ...put('patients', 'sh1', stampAt(Date.now()), { phone: 'соседское свежее' }),
      changed: ['phone'], stamps: { phone: stampAt(Date.now(), 'C') },
    }], S);
    assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'sh1'").get().phone, 'соседское свежее',
      'выложено=' + published + ': более поздняя чужая — применяется');
    db.close();
  }
});

test('7b: тот же срез, применённый дважды, второй раз не делает ничего', () => {
  const db = fresh();
  db.prepare("INSERT INTO sync_peers (node, pub_seq, sent_seq, last_ok) VALUES ('C', 0, 0, ?)")
    .run(new Date().toISOString());
  const slice = [put('patients', 'id1', '000000000001-0000-C', { full_name: 'Иванов', phone: '+998900000001' })];

  const first = applyBatch(db, slice, { ...S, peer: 'C', upto: 40 });
  assert.equal(first.applied, 1);
  assert.equal(db.prepare("SELECT recv_upto FROM sync_peers WHERE node = 'C'").get().recv_upto, 40,
    'квитанция записана: без неё сосед повторял бы срез вечно');

  // Сосед повторяет неподтверждённое в каждом блобе — это норма, а не поломка.
  const second = applyBatch(db, slice, { ...S, peer: 'C', upto: 40 });
  assert.equal(second.already, true, JSON.stringify(second));
  assert.equal(second.applied, 0, 'разбирать второй раз нечего');

  // Местная правка после приёма НЕ должна пострадать от повтора.
  db.prepare("UPDATE patients SET phone = '+998907777777' WHERE uid = 'id1'").run();
  applyBatch(db, slice, { ...S, peer: 'C', upto: 40 });
  assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'id1'").get().phone, '+998907777777');
  db.close();
});

test('7b: в повторе живёт СТАРОЕ авторство — сужается по квитанции, иначе стирает свежую правку соседа', () => {
  const db = fresh();
  db.prepare("INSERT INTO sync_peers (node, pub_seq, sent_seq, last_ok) VALUES ('C', 0, 0, ?)")
    .run(new Date().toISOString());
  // Вставка у соседа — авторство '*' на номере 7: вся строка.
  applyBatch(db, [{
    ...put('patients', 'nw1', '000000000001-0000-C', { full_name: 'Иванов', phone: 'p0', address: '' }),
    changed: ['*'], changed_at: { '*': 7 },
  }], { ...S, peer: 'C', upto: 7 });
  // Здесь правят адрес и ВЫКЛАДЫВАЮТ его: защиты больше нет.
  db.prepare("UPDATE patients SET address = 'Ташкент' WHERE uid = 'nw1'").run();
  db.prepare("UPDATE sync_peers SET pub_seq = (SELECT MAX(seq) FROM sync_journal) WHERE node = 'C'").run();

  // Сосед своей квитанции ещё не видел и повторяет ту же вставку — вместе со
  // своей новой правкой телефона (номер 9) и СНИМКОМ, в котором адреса нет.
  const r = applyBatch(db, [{
    ...put('patients', 'nw1', '000000000009-0000-C', { full_name: 'Иванов', phone: 'p1', address: '' }),
    changed: ['*'], changed_at: { '*': 7, phone: 9 },
  }], { ...S, peer: 'C', upto: 9 });
  const row = db.prepare("SELECT phone, address FROM patients WHERE uid = 'nw1'").get();
  assert.equal(row.phone, 'p1', 'новое авторство (номер выше квитанции) применяется');
  assert.equal(row.address, 'Ташкент',
    'а повтор старого авторства — нет: иначе местная правка пропадала бы НАВСЕГДА');
  assert.ok(!('protected' in r), 'держала её не защита, а сужение авторства: счётчика защиты больше нет вовсе');
  db.close();
});

// --- Задача 7c: у местной правки появилась метка -----------------------------
//
// До этого местная правка метки не имела ВООБЩЕ: sync_seen помнит только
// ПРИНЯТЫЕ метки, то есть сравнение «кто новее» шло чужая-против-чужой, а своя
// держалась одной защитой — а защита по построению временная, она снимается
// выгрузкой. Отсюда и расхождение навсегда: приехавшая вчерашняя правка
// ложилась поверх сегодняшней местной.

test('7c: неподтверждённая местная правка сильнее уже отчеканенной чужой метки', () => {
  const db = fresh();
  const now = Date.now();
  applyBatch(db, [put('patients', 'lw1', stampAt(now - 7200000),
    { full_name: 'Иванов', phone: 'старый' })], S);
  // Сосед всё получил: и строка заведена, и наша правка ниже будет выложена.
  db.prepare("INSERT INTO sync_peers (node, pub_seq, sent_seq, last_ok) VALUES ('C', 0, 0, ?)")
    .run(new Date().toISOString());

  // Местная правка «в 09:50».
  const before = db.prepare('SELECT COALESCE(MAX(seq), 0) s FROM sync_journal').get().s;
  db.prepare("UPDATE patients SET phone = '+998909995950' WHERE uid = 'lw1'").run();
  db.prepare('UPDATE sync_journal SET at = ? WHERE seq > ?')
    .run(new Date(now - 600000).toISOString().replace(/\.\d+Z$/, 'Z'), before);
  // ...и она УЖЕ ВЫЛОЖЕНА: защиты больше нет, спорить нечем, кроме метки.
  db.prepare('UPDATE sync_peers SET pub_seq = (SELECT MAX(seq) FROM sync_journal) WHERE node = ?').run('C');

  // Сосед прислал свою правку той же колонки, но сделанную РАНЬШЕ («в 09:00»).
  const r = applyBatch(db, [{
    ...put('patients', 'lw1', stampAt(now - 3600000), { phone: '+998909995900' }), changed: ['phone'],
  }], S);
  assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'lw1'").get().phone, '+998909995950',
    'своя более поздняя правка обязана пережить чужую более раннюю');
  assert.ok(!('protected' in r), 'держит её МЕТКА, а не защита: счётчика защиты больше нет вовсе');
  assert.equal(r.applied, 0, 'применять в записи оказалось нечего');
  assert.equal(r.skipped, 1, 'и это именно пропуск, отдельного счётчика не заводим');
  db.close();
});

// ЧИСТКА ЖУРНАЛА БОЛЬШЕ НЕ СТИРАЕТ АВТОРСТВО (Задача 7e). Раньше этот тест
// закреплял ОБРАТНОЕ: подтверждённая соседом правка теряла метку вместе с
// журнальной записью, и приехавшее старое значение ложилось поверх неё. Ровно
// на этом сеть сходилась на более ранней правке — при обычном сбое, когда у
// филиала выгрузка отвечает 500, а выборка работает.
test('7e: авторство переживает чистку журнала — старое значение соседа не ложится поверх', () => {
  const db = fresh();
  applyBatch(db, [put('patients', 'lw2', stampAt(T0), { full_name: 'Иванов', phone: 'старый' })], S);
  db.prepare("INSERT INTO sync_peers (node, pub_seq, sent_seq, last_ok) VALUES ('C', 0, 0, ?)")
    .run(new Date().toISOString());
  editAgo(db, 30, "UPDATE patients SET phone = 'моё' WHERE uid = 'lw2'");

  // Сосед подтвердил приём, журнал вычищен (pruneJournal) — как в жизни.
  db.prepare('DELETE FROM sync_journal').run();
  assert.ok(db.prepare("SELECT COUNT(*) n FROM sync_authored WHERE col = 'phone'").get().n > 0,
    'авторство лежит отдельно и чисткой журнала не затрагивается');

  applyBatch(db, [{
    ...put('patients', 'lw2', stampAt(Date.now() - 3600000), { phone: 'соседское час назад' }),
    changed: ['phone'], stamps: { phone: stampAt(Date.now() - 3600000, 'C') },
  }], S);
  assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'lw2'").get().phone, 'моё',
    'правка получасовой давности новее часовой — и остаётся, хотя журнал давно пуст');

  // А по-настоящему более новая чужая правка по-прежнему применяется.
  applyBatch(db, [{
    ...put('patients', 'lw2', stampAt(Date.now()), { phone: 'соседское только что' }),
    changed: ['phone'], stamps: { phone: stampAt(Date.now(), 'C') },
  }], S);
  assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'lw2'").get().phone, 'соседское только что',
    'иначе узел окапывается на своём значении навсегда');
  db.close();
});

test('7c: удаление не сносит строку, которую здесь правили ПОЗЖЕ', () => {
  const db = fresh();
  const now = Date.now();
  applyBatch(db, [put('patients', 'lw3', stampAt(now - 7200000), { full_name: 'Иванов' })], S);
  db.prepare("INSERT INTO sync_peers (node, pub_seq, sent_seq, last_ok) VALUES ('C', 0, 0, ?)")
    .run(new Date().toISOString());
  const before = db.prepare('SELECT COALESCE(MAX(seq), 0) s FROM sync_journal').get().s;
  db.prepare("UPDATE patients SET phone = '+998900000001' WHERE uid = 'lw3'").run();
  db.prepare('UPDATE sync_journal SET at = ? WHERE seq > ?')
    .run(new Date(now - 600000).toISOString().replace(/\.\d+Z$/, 'Z'), before);
  db.prepare('UPDATE sync_peers SET pub_seq = (SELECT MAX(seq) FROM sync_journal) WHERE node = ?').run('C');

  const r = applyBatch(db, [del('patients', 'lw3', stampAt(now - 3600000))], S);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patients WHERE uid = 'lw3'").get().n, 1,
    'строку, с которой здесь только что работали, удаление из прошлого не уносит');
  assert.equal(r.deleted, 0);
  db.close();
});

// --- Задача 7c: отказ базы больше не молчит (ревью I2) ----------------------

test('7c: строку, которую отвергла база, видно в sync_refused, а квитанция всё равно уезжает', () => {
  const db = fresh();
  const now = Date.now();
  // Местный пациент занимает номер карты; приезжий приедет с тем же — UNIQUE.
  db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Местный', 'B-000001')").run();
  db.prepare("INSERT INTO sync_peers (node, pub_seq, sent_seq, last_ok) VALUES ('C', 0, 0, ?)")
    .run(new Date().toISOString());

  const r = applyBatch(db, [
    put('patients', 'rf1', stampAt(now - 60000), { full_name: 'Приезжий', mrn: 'B-000001' }),
    put('patients', 'rf2', stampAt(now - 50000), { full_name: 'Нормальный' }),
  ], { ...S, peer: 'C', upto: 77 });

  assert.equal(r.refused, 1, 'отказ базы считается отдельно от «пропущено»');
  assert.equal(r.applied, 1, 'здоровая запись рядом применилась: одна кривая не отменяет порцию');
  const row = db.prepare("SELECT tbl, uid, peer, err FROM sync_refused").get();
  assert.equal(row.uid, 'rf1');
  assert.equal(row.peer, 'C', 'видно, чей блоб её привёз');
  assert.match(row.err, /UNIQUE|constraint/i, 'и что именно сказала база');
  // Квитанция сдвигается ВСЁ РАВНО: иначе одна «ядовитая» строка повторялась бы
  // в каждом блобе вечно и держала бы журнал соседа.
  assert.equal(db.prepare("SELECT recv_upto FROM sync_peers WHERE node = 'C'").get().recv_upto, 77);
  db.close();
});

// --- Задача 7d: поколоночный спор решает ВРЕМЯ ПРАВКИ ------------------------

// Помощник: местная правка колонки «столько-то минут назад». Время пишут
// триггеры («сейчас»), а тест укладывается в миллисекунды, поэтому проставляем
// его явно — и в журнал, и в sync_authored: с Задачи 7e спор решает именно
// авторство, журнал же чистится и метки не хранит.
const editAgo = (db, minutes, sql, cols = ['phone']) => {
  const before = db.prepare('SELECT COALESCE(MAX(seq), 0) s FROM sync_journal').get().s;
  db.prepare(sql).run();
  const at = new Date(Date.now() - minutes * 60000).toISOString();
  db.prepare('UPDATE sync_journal SET at = ? WHERE seq > ?').run(at, before);
  for (const col of cols) db.prepare('UPDATE sync_authored SET at = ? WHERE col = ?').run(at, col);
};

test('7d: приехавшая колонка НОВЕЕ местной правки — применяется', () => {
  const db = fresh();
  const now = Date.now();
  applyBatch(db, [put('patients', 'ax1', stampAt(now - 7200000), { full_name: 'Иванов', phone: 'исходный' })], S);
  db.prepare("INSERT INTO sync_peers (node, pub_seq, sent_seq, last_ok) VALUES ('C', 0, 0, ?)")
    .run(new Date().toISOString());
  editAgo(db, 60, "UPDATE patients SET phone = 'моё 09:00' WHERE uid = 'ax1'");   // правили час назад
  // Правка ВЫЛОЖЕНА: пока она не выложена, её держит защита (сосед о ней знать
  // не мог), и спор метками до этого просто не доходит.
  db.prepare('UPDATE sync_peers SET pub_seq = (SELECT MAX(seq) FROM sync_journal) WHERE node = ?').run('C');

  applyBatch(db, [{
    ...put('patients', 'ax1', stampAt(now - 600000), { phone: 'соседское 09:50' }),
    changed: ['phone'], stamps: { phone: stampAt(now - 600000, 'C') },   // сосед правил 10 минут назад
  }], S);
  assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'ax1'").get().phone, 'соседское 09:50',
    'позже правил сосед — его значение и должно остаться');
  db.close();
});

test('7d: приехавшая колонка СТАРШЕ местной правки — пропускается', () => {
  const db = fresh();
  const now = Date.now();
  applyBatch(db, [put('patients', 'ax2', stampAt(now - 7200000), { full_name: 'Иванов', phone: 'исходный' })], S);
  db.prepare("INSERT INTO sync_peers (node, pub_seq, sent_seq, last_ok) VALUES ('C', 0, 0, ?)")
    .run(new Date().toISOString());
  editAgo(db, 10, "UPDATE patients SET phone = 'моё 09:50' WHERE uid = 'ax2'");
  // Правка уже выложена — защиты нет, спорит только метка.
  db.prepare('UPDATE sync_peers SET pub_seq = (SELECT MAX(seq) FROM sync_journal) WHERE node = ?').run('C');

  const r = applyBatch(db, [{
    ...put('patients', 'ax2', stampAt(now - 3600000), { phone: 'соседское 09:00' }),
    changed: ['phone'], stamps: { phone: stampAt(now - 3600000, 'C') },
  }], S);
  assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'ax2'").get().phone, 'моё 09:50',
    'позже правили здесь — вчерашний блоб соседа этого не отменяет');
  assert.ok(!('protected' in r), 'держит МЕТКА, а не защита: счётчика защиты больше нет вовсе');
  db.close();
});

test('7d: одна миллисекунда, разные буквы — решает буква, и одинаково у обеих сторон', () => {
  const db = fresh();
  const now = Date.now();
  applyBatch(db, [put('patients', 'ax3', stampAt(now - 7200000), { full_name: 'Иванов', phone: 'исходный' })], S);
  db.prepare("INSERT INTO sync_peers (node, pub_seq, sent_seq, last_ok) VALUES ('C', 0, 0, ?)")
    .run(new Date().toISOString());
  const tie = now - 600000;
  editAgo(db, 10, "UPDATE patients SET phone = 'от B' WHERE uid = 'ax3'");
  db.prepare("UPDATE sync_journal SET at = ? WHERE tbl = 'patients' AND uid = 'ax3' AND cols = 'phone'")
    .run(new Date(tie).toISOString());
  db.prepare("UPDATE sync_authored SET at = ? WHERE tbl = 'patients' AND uid = 'ax3' AND col = 'phone'")
    .run(new Date(tie).toISOString());
  db.prepare('UPDATE sync_peers SET pub_seq = (SELECT MAX(seq) FROM sync_journal) WHERE node = ?').run('C');

  // Этот узел — B, приехало от C: та же миллисекунда, буква C больше.
  applyBatch(db, [{
    ...put('patients', 'ax3', stampAt(tie), { phone: 'от C' }),
    changed: ['phone'], stamps: { phone: stampAt(tie, 'C') },
  }], S);
  assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'ax3'").get().phone, 'от C',
    'C > B по букве — и ровно так же это посчитает сам C, сравнивая те же две строки');
  db.close();
});

test('7d: запись без stamps (сборка соседа до 7d) читается по метке записи', () => {
  const db = fresh();
  const now = Date.now();
  applyBatch(db, [put('patients', 'ax4', stampAt(now - 7200000), { full_name: 'Иванов', phone: 'исходный' })], S);
  applyBatch(db, [put('patients', 'ax4', stampAt(now - 60000), { phone: 'от старой сборки' })], S);
  assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'ax4'").get().phone, 'от старой сборки',
    'узлы в сети обновляются не одновременно — запись без поколоночных меток обязана работать как раньше');
  db.close();
});

// --- Задача 7e: сбитые часы соседа не замораживают колонку -------------------
//
// Метка решает, чья правка новее, поэтому компьютер с часами из будущего
// раздаёт всей сети метки, которые не обгонит ни одна честная правка, — поле
// застывает у ВСЕХ, пока настенное время не догонит. Подрезаем, а не
// отбрасываем: в записи настоящая работа филиала.

test('7e: метка из будущего подрезается, запись применяется, колонка не застревает', () => {
  // База на каждый перекос своя: тест укладывается в миллисекунды, и метки
  // предыдущего прохода мешали бы следующему просто потому, что они соседние.
  for (const [ahead, label] of [[15 * 60000, 'на 15 минут'], [365 * 86400000, 'на год']]) {
    const db = fresh();
    db.prepare("INSERT INTO sync_peers (node, pub_seq, sent_seq, last_ok) VALUES ('C', 0, 0, ?)")
      .run(new Date().toISOString());
    applyBatch(db, [put('patients', 'sk1', stampAt(T0), { full_name: 'Иванов', phone: 'исходный' })], S);
    const future = stampAt(Date.now() + ahead, 'C');
    // Допуск нулевой — иначе «пока часы не догонят» пришлось бы ждать пять
    // минут прямо в тесте. Смысл от этого не меняется: подрезка ограничивает
    // заморозку колонки ДОПУСКОМ, а не годом (и не пятнадцатью годами, если у
    // филиала села батарейка CMOS и часы показывают 2036-й).
    const r = applyBatch(db, [{
      ...put('patients', 'sk1', future, { phone: 'из будущего ' + label }),
      changed: ['phone'], stamps: { phone: future },
    }], { ...S, peer: 'C', skewMaxMs: 0 });
    assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'sk1'").get().phone,
      'из будущего ' + label, label + ': работу филиала не теряем');
    assert.equal(r.skewed > 0, true, label + ': подрезку надо посчитать');
    assert.ok(r.skew_ms >= ahead - 60000, label + ': и назвать, на сколько он спешит');

    const stored = db.prepare("SELECT stamp FROM sync_seen WHERE uid = 'sk1' AND col = 'phone'").get().stamp;
    const storedMs = parseInt(stored.slice(0, 12), 16);
    assert.ok(storedMs <= Date.now() + 1000,
      label + ': в sync_seen метка уже подрезана — иначе она заморозит колонку у всех');

    const honest = stampAt(storedMs + 1, 'C');
    applyBatch(db, [{
      ...put('patients', 'sk1', honest, { phone: 'честное ' + label }),
      changed: ['phone'], stamps: { phone: honest },
    }], { ...S, peer: 'C', skewMaxMs: 60000 });
    assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'sk1'").get().phone, 'честное ' + label,
      label + ': колонка не заморожена дольше допуска');
    assert.ok(db.prepare("SELECT clock_skew_ms FROM sync_peers WHERE node = 'C'").get().clock_skew_ms > 0,
      label + ': перекос запомнен по соседу — карточка филиала покажет его словами');
    db.close();
  }

  // А допуск по умолчанию — пять минут: столько метке из будущего позволено
  // обгонять наши часы, и ровно столько длится заморозка в худшем случае.
  const db2 = fresh();
  applyBatch(db2, [put('patients', 'sk2', stampAt(T0), { full_name: 'Иванов' })], S);
  applyBatch(db2, [{
    ...put('patients', 'sk2', stampAt(Date.now() + 86400000, 'C'), { phone: 'из завтра' }),
    changed: ['phone'], stamps: { phone: stampAt(Date.now() + 86400000, 'C') },
  }], S);
  const st = db2.prepare("SELECT stamp FROM sync_seen WHERE uid = 'sk2' AND col = 'phone'").get().stamp;
  assert.ok(parseInt(st.slice(0, 12), 16) <= Date.now() + 5 * 60000 + 1000,
    'метка «завтра» подрезана до «сейчас + допуск», а не сохранена как есть');
  db2.close();
});

test('7f: подделанная метка не записывает перекос в миллионы лет', () => {
  // Формат метки допускает 48 бит миллисекунд: 'ffffffffffff' — это примерно
  // 8,9 миллиона лет вперёд. Число это едет в sync_peers.clock_skew_ms и на
  // экран, и «часы филиала C спешат на 3 218 000 000 дн» — не подсказка, а
  // мусор вместо неё. Потолок — десять лет: выше него «на сколько именно» уже
  // ничего не меняет.
  const db = fresh();
  db.prepare("INSERT INTO sync_peers (node, pub_seq, sent_seq, last_ok) VALUES ('C', 0, 0, ?)")
    .run(new Date().toISOString());
  applyBatch(db, [put('patients', 'sk9', stampAt(T0), { full_name: 'Иванов', phone: 'исходный' })], S);

  const forged = 'ffffffffffff-0000-C';
  const r = applyBatch(db, [{
    ...put('patients', 'sk9', forged, { phone: 'из конца времён' }),
    changed: ['phone'], stamps: { phone: forged },
  }], { ...S, peer: 'C', skewMaxMs: 0 });

  const TEN_YEARS = 10 * 365 * 24 * 3600 * 1000;
  assert.ok(r.skewed > 0, 'подрезку всё равно надо посчитать: метка была из будущего');
  assert.equal(r.skew_ms, TEN_YEARS, 'перекос назван потолком, а не восемью миллионами лет');
  assert.equal(db.prepare("SELECT clock_skew_ms FROM sync_peers WHERE node = 'C'").get().clock_skew_ms,
    TEN_YEARS, 'и в базе лежит то же число — карточка филиала читает его');
  // Сама запись при этом применена: подрезаем метку, а не выбрасываем работу.
  assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'sk9'").get().phone, 'из конца времён');
  db.close();
});

test('7e: отказ снимается, когда строка всё-таки применяется', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Местный', 'B-000001')").run();
  db.prepare("INSERT INTO sync_peers (node, pub_seq, sent_seq, last_ok) VALUES ('C', 0, 0, ?)")
    .run(new Date().toISOString());
  applyBatch(db, [put('patients', 'rf9', stampAt(T0), { full_name: 'Приезжий', mrn: 'B-000001' })],
    { ...S, peer: 'C', upto: 11 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_refused').get().n, 1, 'база отвергла — видно');

  // Номер освободили, запись приехала снова — отказ больше не факт.
  db.prepare("UPDATE patients SET mrn = 'B-000002' WHERE full_name = 'Местный'").run();
  applyBatch(db, [put('patients', 'rf9', stampAt(Date.now()), { full_name: 'Приезжий', mrn: 'B-000001' })],
    { ...S, peer: 'C', upto: 12 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patients WHERE uid = 'rf9'").get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_refused').get().n, 0,
    'иначе экран годами показывал бы «N записей не приняты» после того, как всё починилось');
  db.close();
});
