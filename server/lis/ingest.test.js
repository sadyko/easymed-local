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
  assert.match(message(db).detail, /Общий анализ крови/, 'услуга обязана быть названа — у клиники их несколько с похожими именами');
  db.close();
});

test('у услуги нет панели → unmapped, и услуга НАЗВАНА по имени', () => {
  // У клиники бывает несколько похоже названных услуг: «Общий анализ крови
  // (CBC)», «(ОАК)», «(стационар)». Безымянное «у услуги нет панели» не
  // отвечает на единственный вопрос, который человек задаёт в этот момент.
  const db = fresh();
  db.prepare('UPDATE lab_panels SET service_id = NULL WHERE id = 5').run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /Общий анализ крови/, 'в лотке обязано быть имя услуги, а не только слово «услуга»');
  assert.equal(results(db).length, 0);
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

test('панель кормится анализатором ДРУГОЙ МОДЕЛИ → unmatched, значения не пишутся', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'Биохимия','mindray-bs-240')").run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1', 2);
  assert.equal(message(db).status, 'unmatched');
  assert.match(message(db).detail, /другой модел/i);
  assert.equal(results(db).length, 0);
  db.close();
});

// НЕСКОЛЬКО ОДИНАКОВЫХ ПРИБОРОВ — обычное дело в лаборатории.
test('второй анализатор ТОЙ ЖЕ модели принимается: пробу мог прогнать любой из них', () => {
  // Панель привязана к прибору 1. Пробирку прогнали на приборе 2 — такой же
  // BC-5300, стоящий рядом. Отказ означал бы, что результат теряется в
  // зависимости от того, какая машина оказалась свободна, а коды каналов у
  // одинаковых моделей те же самые — сопоставление панели верно для обеих.
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'Гематология 2','mindray-bc-5300')").run();
  // Проба полная: с LIS_MINDRAY_CODES_V1 (решение владельца 2026-09-28) бланк,
  // в котором не пришла подтверждённая строка, лежит в лотке. Этот тест — про
  // приём с прибора той же модели, поэтому проба заполняет весь бланк.
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142', { unit: 'g/L' })]), '10.0.0.12', 2);

  assert.equal(results(db).length, 2, 'результат с одинаковой модели обязан лечь');
  assert.equal(results(db)[0].value, '6.1');
  assert.equal(message(db).status, 'applied');
  db.close();
});

test('прибор без модели к чужой панели не допускается — пустой профиль не «совпадает» ни с чем', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'Неизвестный','')").run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '10.0.0.13', 2);
  assert.equal(message(db).status, 'unmatched');
  assert.equal(results(db).length, 0, 'иначе любой неопознанный прибор писал бы в любую панель');
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

// ── LIS_MINDRAY_CODES_V1 — провод Mindray: OBX-3 = «LOINC^ИМЯ^LN» ────────────
// Воспроизведено 2026-09-28 на копии базы: «6690-2^WBC^LN» → ACK AA и ни одного
// значения в бланке. Симулятор слал «КОД^^99MRC» и ошибку поймать не мог.
const OBXR = (n, id, value, opts = {}) =>
  `OBX|${n}|${opts.type || 'NM'}|${id}||${value}|${opts.unit || '10*9/L'}|${opts.range || ''}|${opts.flag || ''}|||${opts.status || 'F'}`;

test('Mindray «6690-2^WBC^LN» ложится в строку, подтверждённую как WBC', () => {
  const db = fresh();
  const code = ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', '9.81'), OBXR(2, '718-7^HGB^LN', '142', { unit: 'g/L' })]), '127.0.0.1');
  assert.equal(code, 'AA');
  const wbc = results(db).find((r) => r.parameter === 'Лейкоциты');
  assert.ok(wbc, 'до исправления здесь было 0 значений при ACK AA');
  assert.equal(wbc.value, '9.81');
  assert.equal(message(db).status, 'applied');
  db.close();
});

test('Mindray «6690-2^WBC^LN» ложится и в строку, подтверждённую кодом LOINC 6690-2', () => {
  const db = fresh();
  db.prepare("UPDATE lab_panel_analytes SET device_code = '6690-2' WHERE code = 'WBC'").run();
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', '9.81'), OBXR(2, '718-7^HGB^LN', '142')]), '127.0.0.1');
  assert.equal(results(db).find((r) => r.parameter === 'Лейкоциты').value, '9.81');
  assert.equal(message(db).status, 'applied');
  db.close();
});

test('Mindray: неподтверждённый код не применяется, проба в лотке с полным кодом', () => {
  const db = fresh({ confirmed: 0 });
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', '9.81'), OBXR(2, '718-7^HGB^LN', '142')]), '127.0.0.1');
  assert.equal(results(db).filter((r) => r.parameter === 'Лейкоциты').length, 0, 'D4: совпадение само по себе не разрешение');
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /не подтверждено: 6690-2\^WBC\^LN/);
  db.close();
});

test('бланк заполнен, лишние строки Mindray (режимы, референсная группа, гистограмма) — не в лоток', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [
    OBXR(1, '08001^Take Mode^99MRC', 'O', { type: 'IS' }),
    OBXR(2, '01002^Ref Group^99MRC', 'General', { type: 'IS' }),
    OBXR(3, '6690-2^WBC^LN', '9.81'),
    OBXR(4, '718-7^HGB^LN', '142'),
    OBXR(5, '15551-4^WBC Histogram. BMP^99MRC', '^Image^BMP^Base64^Qk0=', { type: 'ED' }),
  ]), '127.0.0.1');
  assert.equal(results(db).length, 2);
  const m = message(db);
  assert.equal(m.status, 'applied', 'нормальная проба Mindray не требует клика в «Необработанных»');
  assert.match(m.detail, /не использованы: 08001\^Take Mode\^99MRC, 01002\^Ref Group\^99MRC, 15551-4\^WBC Histogram\. BMP\^99MRC/);
  db.close();
});

test('подтверждённая строка бланка не пришла — проба в лотке, строка названа, пришедшее записано', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', '9.81')]), '127.0.0.1');
  assert.equal(results(db).length, 1, 'то, что пришло, всё равно ложится');
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /не пришли: Гемоглобин \(HGB\)/);
  db.close();
});

test('пустое значение не стирает набранное руками и считается «не пришло»', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, source, entered_by) VALUES (123,'Лейкоциты','9.9','manual',7)").run();
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', ''), OBXR(2, '718-7^HGB^LN', '142')]), '127.0.0.1');
  const wbc = results(db).find((r) => r.parameter === 'Лейкоциты');
  assert.equal(wbc.value, '9.9');
  assert.equal(wbc.source, 'manual');
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /Лейкоциты \(WBC, пустое значение\)/);
  db.close();
});

test('две строки прибора на одну строку бланка — ложится совпавшая по коду, вторая — «повтор», проба в лотке', () => {
  // Ревью R6: спор двух чисел за одну строку бланка решает человек.
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '12345^WBC^99MRC', '1.0'), OBXR(2, 'WBC^^99MRC', '2.0'), OBXR(3, 'HGB^^99MRC', '142')]), '127.0.0.1');
  assert.equal(results(db).find((r) => r.parameter === 'Лейкоциты').value, '2.0');
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /повтор: 12345\^WBC\^99MRC/);
  db.close();
});

test('флаг «H~N» без диапазона клиники — высокий, а не «отклонение»', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', '12.36', { flag: 'H~N' })]), '127.0.0.1');
  assert.equal(results(db)[0].flag, 'high');
  db.close();
});

// ── Ревью 2026-09-28 ────────────────────────────────────────────────────────

test('R2: две подтверждённые строки бланка с одним кодом — проба в лотке, вторая названа', () => {
  const db = fresh();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed)
              VALUES (5,'WBC#','Лейкоциты (абс.)','10^9/л',3,'WBC',1)`).run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142')]), '127.0.0.1');
  assert.equal(results(db).find((r) => r.parameter === 'Лейкоциты').value, '6.1');
  assert.equal(results(db).filter((r) => r.parameter === 'Лейкоциты (абс.)').length, 0);
  assert.equal(message(db).status, 'unmapped', 'пустая строка бланка при «применено» — ложное «всё легло»');
  assert.match(message(db).detail, /не пришли: Лейкоциты \(абс\.\) \(WBC, код уже у строки «Лейкоциты»\)/);
  db.close();
});

test('R5: код неподтверждённой строки пришёл, хотя его взяла подтверждённая, — проба в лотке', () => {
  const db = fresh();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed)
              VALUES (5,'WBC-LN','Лейкоциты (LOINC)','10^9/л',3,'6690-2',0)`).run();
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', '9.81'), OBXR(2, '718-7^HGB^LN', '142')]), '127.0.0.1');
  assert.equal(results(db).find((r) => r.parameter === 'Лейкоциты').value, '9.81');
  assert.equal(results(db).filter((r) => r.parameter === 'Лейкоциты (LOINC)').length, 0, 'D4: неподтверждённое не применяется');
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /не подтверждено: 6690-2\^WBC\^LN/);
  db.close();
});
