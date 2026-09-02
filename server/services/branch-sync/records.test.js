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
import { SHIPPED } from './journal.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('DELETE FROM sync_journal').run();
  return db;
}
const S = { self: 'B' };
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
  applyBatch(db, [put('patients', 'tttt', '000000000001-0000-C', { full_name: 'Иванов' })], S);
  applyBatch(db, [del('patients', 'tttt', '000000000009-0000-C')], S);
  applyBatch(db, [put('patients', 'tttt', '000000000005-0000-C', { full_name: 'Иванов' })], S);   // собран ДО удаления
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patients WHERE uid = 'tttt'").get().n, 0, 'отправитель удаление не повторит — воскрешение было бы навсегда');
  // А put НОВЕЕ надгробия — законное повторное заведение.
  applyBatch(db, [put('patients', 'tttt', '000000000012-0000-C', { full_name: 'Иванов снова' })], S);
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
test('местная неотправленная правка защищает и ССЫЛКИ, а не только поля', () => {
  const db = fresh();
  applyBatch(db, [
    put('patients', 'pX', '000000000001-0000-C', { full_name: 'Первый' }),
    put('patients', 'pY', '000000000002-0000-C', { full_name: 'Второй' }),
    put('visits', 'vX', '000000000003-0000-C', { visit_date: '2026-09-01', status: 'scheduled' }, { patient_id: 'pX' }),
  ], S);
  const px = db.prepare("SELECT id FROM patients WHERE uid = 'pX'").get().id;
  db.prepare("UPDATE visits SET status = 'arrived' WHERE uid = 'vX'").run();   // соседу C ещё не отправлено
  applyBatch(db, [put('visits', 'vX', '000000000009-0000-C',
    { visit_date: '2026-09-01', status: 'scheduled' }, { patient_id: 'pY' })], S);
  const v = db.prepare("SELECT patient_id, status FROM visits WHERE uid = 'vX'").get();
  assert.equal(v.status, 'arrived', 'поле защищено');
  assert.equal(v.patient_id, px, 'перевесить визит на ДРУГОГО пациента не лучше, чем стереть телефон');
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

  // Запись без origin (сосед старой сборки) не должна ронять порцию.
  applyBatch(db, [{ tbl: 'patients', uid: 'oo2', op: 'put', stamp: '000000000002-0000-C', data: { full_name: 'Безымянный' }, refs: {} }], S);
  assert.equal(db.prepare("SELECT sync_origin FROM patients WHERE uid = 'oo2'").get().sync_origin, null,
    'без origin метку выдумывать нечем — строка просто не подписана');
  db.close();
});

test('метка происхождения не уезжает обратно: у соседа своя точка зрения', () => {
  for (const tbl of Object.keys(SHIPPED)) {
    assert.ok(!SHIPPED[tbl].includes('sync_origin'),
      tbl + ': отправив метку, B объявил бы C, что собственные строки C — чужие');
  }
});
