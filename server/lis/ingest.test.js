// ingest.test.js — главный тест подсистемы. Каждое утверждение здесь — это
// решение владельца или инвариант безопасности пациента, а не удобство.
// Падение любого из них означает, что результат может лечь не туда, не тем
// значением или быть выдан без человека.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { ingestMessage, parseSampleId } from './ingest.js';

const MSG = (sampleId, obx) => [
  'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1',
  `OBR|1||${sampleId}|00001^Automated Count^99MRC`,
  ...obx,
].join('\r');

const OBX = (n, code, value, opts = {}) =>
  `OBX|${n}|${opts.type || 'NM'}|${code}^^99MRC||${value}|${opts.unit || '10*9/L'}|${opts.range || ''}|${opts.flag || ''}|||${opts.status || 'F'}`;

/** Клиника с одним анализатором, одной панелью и одним лабораторным заказом. */
function seed(db, { confirmed = 1, refLow = null, refHigh = null } = {}) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (7,'lab','x','Лаборант','lab')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-09-10T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'Общий анализ крови',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (123,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile, transport, port) VALUES (1,'Гематология','mindray-bc-5300','mllp',2575)").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'ОАК',9,1)").run();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed, ref_low, ref_high)
              VALUES (5,'WBC','Лейкоциты','10^9/л',1,'WBC',?,?,?)`).run(confirmed, refLow, refHigh);
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed)
              VALUES (5,'HGB','Гемоглобин','г/л',2,'HGB',1)`).run();
}

function fresh(opts) {
  const db = openDb(':memory:');
  migrate(db);
  seed(db, opts);
  return db;
}

const results = (db) => db.prepare('SELECT * FROM lab_results WHERE visit_service_id = 123 ORDER BY id').all();
const message = (db) => db.prepare('SELECT * FROM lab_device_messages ORDER BY id DESC LIMIT 1').get();
const order = (db) => db.prepare('SELECT * FROM visit_services WHERE id = 123').get();

test('номер пробы: префикс, ведущие нули и голые цифры — одно и то же', () => {
  assert.equal(parseSampleId('LAB-000123'), 123);
  assert.equal(parseSampleId('lab_000123'), 123);
  assert.equal(parseSampleId('000123'), 123);
  assert.equal(parseSampleId('123'), 123);
  assert.equal(parseSampleId(''), null);
  assert.equal(parseSampleId('ABC'), null);
  assert.equal(parseSampleId('0'), null, 'нулевой заказ не существует');
});

test('совпадение по LAB-000123: значения легли, заказ ждёт проверки', () => {
  const db = fresh();
  const code = ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142', { unit: 'g/L' })]), '127.0.0.1');
  assert.equal(code, 'AA');

  const rows = results(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].parameter, 'Лейкоциты', 'имя обязано браться из панели, а не из провода (инвариант 4)');
  assert.equal(rows[0].unit, '10^9/л', 'единица тоже из панели: отчёт остаётся на одном языке');
  assert.equal(rows[0].value, '6.1');
  assert.equal(rows[0].numeric_value, 6.1);
  assert.equal(rows[0].source, 'analyzer');
  assert.equal(rows[0].entered_by, null, 'строку не вводил человек — выдуманный пользователь испортил бы журнал персонала');
  assert.equal(order(db).status, 'resulted');
  assert.equal(message(db).status, 'applied');
  db.close();
});

test('голые цифры тоже принимаются — сканер может не передавать префикс', () => {
  const db = fresh();
  ingestMessage(db, MSG('000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');
  assert.equal(results(db).length, 1);
  db.close();
});

// ИНВАРИАНТ 1 — машина печатает, подписывает человек.
test('приём НИКОГДА не выдаёт результат', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');
  const r = results(db)[0];
  assert.equal(r.verified_by, null);
  assert.equal(r.verified_at, null);
  assert.notEqual(order(db).status, 'completed', 'автовыдачи нет и не будет');
  db.close();
});

test('время забора не подставляется задним числом', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');
  assert.equal(order(db).sample_collected_at, null, 'Easy-Med не выдумывает время, которого не наблюдал');
  db.close();
});

// РЕШЕНИЕ ВЛАДЕЛЬЦА D4 — подсказка разрешена, тихое применение нет.
test('неподтверждённое сопоставление НЕ применяется, даже когда код совпал', () => {
  const db = fresh({ confirmed: 0 });
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142')]), '127.0.0.1');

  const rows = results(db);
  assert.equal(rows.length, 1, 'применён обязан быть ТОЛЬКО подтверждённый показатель');
  assert.equal(rows[0].parameter, 'Гемоглобин');
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /WBC/, 'лоток обязан назвать, какой именно канал не применён');
  db.close();
});

// ИНВАРИАНТ 3 — референсы принадлежат клинике, а не прибору.
test('диапазон клиники бьёт диапазон прибора', () => {
  const db = fresh({ refLow: 4, refHigh: 9 });
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '12.0', { range: '0-100', flag: 'N' })]), '127.0.0.1');
  const r = results(db)[0];
  assert.equal(r.flag, 'high', 'прибор сказал «норма» по СВОЕМУ диапазону — считать обязаны по диапазону клиники');
  db.close();
});

test('без диапазона клиники берётся флаг прибора, LL — это критическое', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '0.4', { flag: 'LL' })]), '127.0.0.1');
  assert.equal(results(db)[0].flag, 'critical', 'паника обязана зажечь существующий счётчик критических');
  db.close();
});

test('«<0.01» остаётся текстом, число не выдумывается', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '<0.01')]), '127.0.0.1');
  const r = results(db)[0];
  assert.equal(r.value, '<0.01');
  assert.equal(r.numeric_value, null, 'у «меньше чем» нет числового значения — иначе смысл теряется');
  db.close();
});

test('предварительный результат (P) записан в лоток, но не в бланк', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1', { status: 'P' })]), '127.0.0.1');
  assert.equal(results(db).length, 0);
  assert.ok(message(db), 'сообщение всё равно обязано сохраниться');
  assert.match(message(db).detail, /WBC/);
  db.close();
});

// РЕШЕНИЕ ВЛАДЕЛЬЦА D6 — машина побеждает в черновике.
test('значение анализатора замещает набранное руками в НЕвыданном бланке', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, source, entered_by) VALUES (123,'Лейкоциты','9.9','manual',7)").run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');

  const rows = results(db).filter((r) => r.parameter === 'Лейкоциты');
  assert.equal(rows.length, 1, 'повторный прогон обязан обновлять, а не плодить строки');
  assert.equal(rows[0].value, '6.1');
  assert.equal(rows[0].source, 'analyzer');
  db.close();
});

test('повторный прогон обновляет ту же строку, а не дублирует', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '7.2')]), '127.0.0.1');
  const rows = results(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, '7.2');
  db.close();
});

// РЕШЕНИЕ ВЛАДЕЛЬЦА D7 — выданный результат машина молча не переписывает.
test('по выданному бланку сообщение помечается superseded и в бланк не идёт', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');
  db.prepare("UPDATE lab_results SET verified_by = 7, verified_at = '2026-09-10T10:00:00Z' WHERE visit_service_id = 123").run();
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = 123").run();

  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '7.7')]), '127.0.0.1');

  assert.equal(results(db)[0].value, '6.1', 'выданный отчёт пациента не переписывается молча');
  assert.equal(message(db).status, 'superseded');
  assert.equal(order(db).status, 'completed', 'выданный заказ не откатывается назад');
  db.close();
});

// ИНВАРИАНТ 2 — ничего не теряется.
test('неизвестный номер пробы: unmatched, сырое сообщение сохранено целиком', () => {
  const db = fresh();
  const code = ingestMessage(db, MSG('LAB-999999', [OBX(1, 'WBC', '6.1')]), '10.0.0.9');
  assert.equal(code, 'AA', 'ACK: сообщение принято и сохранено — повторять прибору незачем');
  const m = message(db);
  assert.equal(m.status, 'unmatched');
  assert.equal(m.peer, '10.0.0.9');
  assert.match(m.raw, /LAB-999999/, 'сырое сообщение обязано лежать целиком');
  assert.equal(results(db).length, 0);
  db.close();
});

test('услуга не лабораторная → unmatched с этой причиной', () => {
  const db = fresh();
  db.prepare('UPDATE services SET is_lab = 0 WHERE id = 9').run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');
  assert.equal(message(db).status, 'unmatched');
  assert.match(message(db).detail, /не лабораторная/);
  db.close();
});

test('панель без анализатора → unmapped: клиника ещё не сказала, кто её кормит', () => {
  const db = fresh();
  db.prepare('UPDATE lab_panels SET device_id = NULL WHERE id = 5').run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /не привязана/);
  assert.equal(results(db).length, 0);
  db.close();
});

test('панель кормится ДРУГИМ анализатором → unmatched, значения не пишутся', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'Биохимия','mindray-bs-240')").run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1', 2);
  assert.equal(message(db).status, 'unmatched');
  assert.match(message(db).detail, /другим анализатором/);
  assert.equal(results(db).length, 0);
  db.close();
});

test('неразбираемое сообщение → rejected и NAK', () => {
  const db = fresh();
  const code = ingestMessage(db, 'это не HL7', '127.0.0.1');
  assert.equal(code, 'AE');
  assert.equal(message(db).status, 'rejected');
  assert.match(message(db).raw, /это не HL7/, 'даже мусор сохраняется сырым');
  db.close();
});

test('успешный приём отмечает, что прибор на связи', () => {
  const db = fresh();
  assert.equal(db.prepare('SELECT last_seen_at FROM lab_devices WHERE id = 1').get().last_seen_at, null);
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1', 1);
  assert.ok(db.prepare('SELECT last_seen_at FROM lab_devices WHERE id = 1').get().last_seen_at,
    'без отметки «на связи» экран не отличит работающий прибор от молчащего');
  db.close();
});
