// ingest.test.js — главный тест подсистемы. Каждое утверждение здесь — это
// решение владельца или инвариант безопасности пациента, а не удобство.
// Падение любого из них означает, что результат может лечь не туда, не тем
// значением или быть выдан без человека.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { ingestMessage, parseSampleId } from './ingest.js';
import { ensureDevice } from './discover.js';   // LIS_DISCOVERY_FIX_V1 — провод целиком, как index.js
import { parseMessage } from './hl7.js';
import { SERIES_PENDING_PREFIX, resolveMessage } from './inbox.js';   // LIS_REAL_ANALYZERS_V1_SERIES

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

test('R11: «***» на числовой строке не стирает набранное руками и считается «не пришло»', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, source, entered_by) VALUES (123,'Лейкоциты','9.9','manual',7)").run();
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', '***'), OBXR(2, '718-7^HGB^LN', '142')]), '127.0.0.1');
  const wbc = results(db).find((r) => r.parameter === 'Лейкоциты');
  assert.equal(wbc.value, '9.9', 'черновик лаборанта не стёрт');
  assert.equal(wbc.source, 'manual');
  assert.equal(message(db).status, 'unmapped');
  // LIS_DISCOVERY_FIX_V1 — одни звёздочки: «нет значения» у любой строки.
  assert.match(message(db).detail, /не пришли: Лейкоциты \(WBC, нет значения: \*\*\*\)/);
  db.close();
});

// LIS_DISCOVERY_FIX_V1 (ревью 2026-09-29) — «***» и на текстовой строке (ST)
// не значение: R11 ловил только числовые, и звёздочки ST стирали черновик.
test('«***» на текстовой строке (ST) не стирает набранное руками; проба в лотке', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, source, entered_by) VALUES (123,'Лейкоциты','9.9','manual',7)").run();
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', '***', { type: 'ST' }), OBXR(2, '718-7^HGB^LN', '142')]), '127.0.0.1');
  const wbc = results(db).find((r) => r.parameter === 'Лейкоциты');
  assert.equal(wbc.value, '9.9', 'черновик лаборанта не стёрт');
  assert.equal(wbc.source, 'manual');
  assert.equal(results(db).find((r) => r.parameter === 'Гемоглобин').value, '142', 'пришедшее всё равно ложится');
  assert.equal(message(db).status, 'unmapped', 'проба в лотке');
  assert.match(message(db).detail, /не пришли: Лейкоциты \(WBC, нет значения: \*\*\*\)/);
  db.close();
});

test('R11: «>1000» и «*6.1» пишутся текстом, как прежде, и бланк принят', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', '*6.1'), OBXR(2, '718-7^HGB^LN', '>1000')]), '127.0.0.1');
  assert.equal(results(db).find((r) => r.parameter === 'Лейкоциты').value, '*6.1');
  const hgb = results(db).find((r) => r.parameter === 'Гемоглобин');
  assert.equal(hgb.value, '>1000');
  assert.equal(hgb.numeric_value, null, 'число не выдумывается');
  assert.equal(message(db).status, 'applied');
  db.close();
});

// ── LIS_ANALYZER_LIST_V1 — «на связи» на любом разобранном сообщении ────────
const lastSeen = (db) => db.prepare('SELECT last_seen_at FROM lab_devices WHERE id = 1').get().last_seen_at;

test('проба со смазанным штрихкодом (unmatched) всё равно отмечает прибор «на связи»', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-999999', [OBX(1, 'WBC', '6.1')]), '127.0.0.1', 1);
  assert.equal(message(db).status, 'unmatched');
  assert.ok(lastSeen(db), 'прибор говорил — значит, он на связи («kjkj» выглядел молчащим неделю)');
  db.close();
});

test('проба без привязанной панели (unmapped) отмечает прибор; мусор (rejected) — нет', () => {
  const db = fresh();
  db.prepare('UPDATE lab_panels SET device_id = NULL WHERE id = 5').run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1', 1);
  assert.equal(message(db).status, 'unmapped');
  assert.ok(lastSeen(db));
  db.close();

  const db2 = fresh();
  ingestMessage(db2, 'это не HL7', '127.0.0.1', 1);
  assert.equal(message(db2).status, 'rejected');
  assert.equal(lastSeen(db2), null, 'неразобранное не доказывает, что говорил анализатор');
  db2.close();
});

// Ревью M4 — повторный прогон старого сообщения (ручная привязка из лотка)
// просит не отмечать связь: нажал человек, а не заговорил анализатор.
test('ревью M4: { touch: false } — приём как обычно, но прибор «на связи» не отмечается', () => {
  const db = fresh();
  const code = ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142', { unit: 'g/L' })]), '127.0.0.1', 1, { touch: false });
  assert.equal(code, 'AA');
  assert.equal(message(db).status, 'applied', 'всё остальное — тот же приём');
  assert.equal(results(db).length, 2);
  assert.equal(lastSeen(db), null);
  db.close();
});

// ── LIS_DISCOVERY_FIX_V1 (ревью 2026-09-29, S5) — провод целиком, как index.js:
// ensureDevice, потом ingestMessage. Человек привязал панель к находке и
// поправил её модель. Раньше следующая проба искала строку по УГАДАННОЙ модели,
// заводила дубль, и панель отвечала «кормится анализатором другой модели» —
// все пробы уходили в лоток.
test('S5: панель у находки с исправленной моделью — следующая проба ложится в бланк, дубля нет', () => {
  const db = fresh();
  // Прибор сида стоит на своём адресе: иначе он, единственный без адреса,
  // забрал бы первую пробу сам (правило владельца), и находки бы не было.
  db.prepare("UPDATE lab_devices SET host = '10.0.0.5' WHERE id = 1").run();
  const first = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.60', port: 2575 });
  assert.equal(first.created, true, 'находка');
  db.prepare('UPDATE lab_panels SET device_id = ? WHERE id = 5').run(first.device.id);
  // «Изменить» с выбранной моделью: лаборант знает свой аппарат лучше догадки.
  db.prepare("UPDATE lab_devices SET profile = 'mindray-bc-2800', added = 1, model_confirmed = 1 WHERE id = ?").run(first.device.id);

  const raw = MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142', { unit: 'g/L' })]);
  const next = ensureDevice(db, { sendingApp: parseMessage(raw).sendingApp, peer: '10.0.0.60', port: 2575 });
  assert.equal(next.created, false, 'раньше здесь заводилась «BC-5300 (10.0.0.60)»');
  assert.equal(next.device.id, first.device.id);
  assert.equal(ingestMessage(db, raw, '10.0.0.60', next.device.id), 'AA');
  assert.equal(message(db).status, 'applied', 'раньше — unmatched: «кормится анализатором другой модели»');
  assert.equal(results(db).length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_devices').get().c, 2, 'прибор сида и находка — дубля нет');
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1_SERIES — BS-200 шлёт по одному тесту в сообщении ──
// Правило лотка владельца (2026-09-28) то же: проба принята, когда каждая
// подтверждённая строка бланка получила значение. У прибора с
// oneTestPerMessage «бланк заполнен» судится по СЕРИИ — сообщениям этого
// заказа с прибора той же модели за 60 минут, а не по одному сообщению.
// Пока не пришли только строки бланка — сообщение лежит в лотке с отметкой
// «ждём» (SERIES_PENDING_PREFIX); дошла серия — ранние строки становятся
// applied в той же транзакции. D4, D7 и запрет автовыдачи не меняются.
// Фикстуры — руководство BS-200 (Host Interface Manual v1.2), с. 24–25.
const BS = (n, name, value, { label = 'LAB-000123', status = 'F', id = '1' } = {}) => [
  `MSH|^~\\&|Mindray|BS-200E|||20261001101500||ORU^R01|${id}|P|2.3.1||||0||ASCII|||`,
  'PID|1|854||12|Tommy||19830719145307|F|A||||||||||||||||||||||',
  `OBR|1|${label}|2|Mindray^BS-200E|Y||||||||||serum|||||||||||||||||||||||||||||||||`,
  `OBX|1|NM|${n}|${name}|${value}|g/ml|-||||${status}|||||||`,
].join('\r');

/** Клиника с BS-200 (прибор 1, профиль mindray-bs-200) и биохимией из трёх строк. */
function chem({ profile = 'mindray-bs-200', lines = [['GLU', 'Глюкоза', '2'], ['UREA', 'Мочевина', '3'], ['CALC', 'Расчётный', '102']], unconfirmed = [] } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-10-01T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'Биохимия',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (123,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile, transport, port) VALUES (1,'BS-200',?,'mllp',2575)").run(profile);
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'Биохимия',9,1)").run();
  lines.forEach(([code, name, dc], i) => {
    db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed)
                VALUES (5, ?, ?, '', ?, ?, ?)`).run(code, name, i + 1, dc, unconfirmed.includes(code) ? 0 : 1);
  });
  return db;
}
const rows = (db) => db.prepare('SELECT * FROM lab_device_messages ORDER BY id').all();
const tray = (db) => db.prepare('SELECT * FROM lab_device_messages WHERE resolved_at IS NULL AND status <> \'applied\' ORDER BY id').all();
const blank = (db) => Object.fromEntries(db.prepare('SELECT parameter, value FROM lab_results WHERE visit_service_id = 123').all().map((r) => [r.parameter, r.value]));
const ago = (db, id, minutes) => db.prepare(`UPDATE lab_device_messages SET received_at = strftime('%Y-%m-%dT%H:%M:%SZ','now', ?) WHERE id = ?`).run('-' + minutes + ' minutes', id);

test('серия BS-200: после 1-го и 2-го — «ждём остальные», после 3-го — все три applied, лоток пуст', () => {
  const db = chem();
  assert.equal(SERIES_PENDING_PREFIX, 'серия: ждём остальные строки — ');
  ingestMessage(db, BS('2', 'test2', '5.000000'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'unmapped');
  assert.equal(message(db).detail, SERIES_PENDING_PREFIX + 'не пришли: Мочевина (3), Расчётный (102)');
  ingestMessage(db, BS('3', 'test3', '10.000000', { id: '2' }), '10.0.0.40', 1);
  assert.equal(message(db).detail, SERIES_PENDING_PREFIX + 'не пришли: Расчётный (102)');
  ingestMessage(db, BS('102', 'calctest1', '15.000000', { id: '3' }), '10.0.0.40', 1);

  const all = rows(db);
  assert.deepEqual(all.map((m) => m.status), ['applied', 'applied', 'applied']);
  assert.equal(all[2].detail, 'серия из 3 сообщений принята');
  assert.equal(all[0].detail, 'принято серией (сообщение № ' + all[2].id + ')');
  assert.equal(all[1].detail, 'принято серией (сообщение № ' + all[2].id + ')');
  assert.deepEqual(all.map((m) => m.resolved_at), [null, null, null], 'серия не «разрешает» строки — она их принимает');
  assert.deepEqual(tray(db), [], 'в «Необработанных» пусто');
  assert.deepEqual(blank(db), { 'Глюкоза': '5', 'Мочевина': '10', 'Расчётный': '15' });
  assert.equal(order(db).status, 'resulted');
  assert.ok(all.every((m) => m.raw.startsWith('MSH|^~\\&|Mindray|BS-200E')), 'сырое не трогается (инвариант 2)');
  db.close();
});

test('серия: ИНВАРИАНТ 1 — дошедшая серия не выдаёт результат', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  for (const r of db.prepare('SELECT * FROM lab_results WHERE visit_service_id = 123').all()) {
    assert.equal(r.verified_at, null);
    assert.equal(r.verified_by, null);
  }
  assert.notEqual(order(db).status, 'completed');
  db.close();
});

test('серия: тест, которого нет в панели, — unmapped в лотке и серию не портит', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  ingestMessage(db, BS('77', 'other', '1'), '10.0.0.40', 1);
  const stray = message(db);
  assert.equal(stray.status, 'unmapped');
  assert.ok(!stray.detail.startsWith(SERIES_PENDING_PREFIX), 'ничего не легло — правило одного сообщения, не «ждём»');
  assert.match(stray.detail, /не использованы: 77 \(other\)/);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.equal(message(db).detail, 'серия из 3 сообщений принята', 'чужой тест в серию не вошёл');
  assert.deepEqual(tray(db).map((m) => m.id), [stray.id], 'в лотке — только чужой тест: его можно «Привязать»');
  db.close();
});

test('серия: повторный прогон с другим значением — «повтор», в бланке последнее', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5.1'), '10.0.0.40', 1);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  ingestMessage(db, BS('2', 'test2', '5.4'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'unmapped');
  assert.equal(message(db).detail, 'повтор: 2 (test2): было 5.1, в бланке 5.4');
  assert.equal(blank(db)['Глюкоза'], '5.4', 'D6: каждое сообщение пишет своё — в бланке последнее');
  assert.deepEqual(rows(db).slice(0, 3).map((m) => m.status), ['applied', 'applied', 'applied'], 'принятые раньше не трогаются');
  db.close();
});

test('серия: то же значение ещё раз (прибор не получил ACK) — не повтор, серия чистая', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5.1'), '10.0.0.40', 1);
  ingestMessage(db, BS('2', 'test2', '5.100000'), '10.0.0.40', 1);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'applied');
  assert.equal(message(db).detail, 'серия из 4 сообщений принята; повторная передача: 2 (test2)');
  assert.deepEqual(tray(db), []);
  db.close();
});

test('серия: неподтверждённый код во 2-м сообщении — серия не чистая, строки в лотке (D4)', () => {
  const db = chem({ unconfirmed: ['UREA'] });
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'unmapped');
  // Из сообщения ничего не легло — правило одного сообщения, и в серию оно не
  // входит (спецификация, раздел 3, п. 2): лежит в лотке само по себе.
  assert.equal(message(db).detail, 'не пришли: Глюкоза (2), Расчётный (102); не подтверждено: 3 (test3)');
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'applied', 'подтверждённые строки бланка — Глюкоза и Расчётный — пришли');
  assert.equal(blank(db)['Мочевина'], undefined, 'D4: неподтверждённое не применяется');
  assert.equal(tray(db).length, 1, 'сообщение с неподтверждённым кодом — в лотке');
  db.close();
});

test('серия: неподтверждённый код вместе с подтверждённым — серия не чистая до правки', () => {
  const db = chem({ lines: [['GLU', 'Глюкоза', '2'], ['UREA', 'Мочевина', '3'], ['TP', 'Белок', '9']], unconfirmed: ['TP'] });
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  const raw2 = BS('3', 'test3', '10').replace(/\rOBX.*$/, '\rOBX|1|NM|3|test3|10|g/ml|-||||F\rOBX|2|NM|9|TP|70|g/l|-||||F');
  ingestMessage(db, raw2, '10.0.0.40', 1);
  assert.equal(message(db).status, 'unmapped');
  assert.equal(message(db).detail, 'не подтверждено: 9 (TP)', 'не «ждём»: значение для неподтверждённой строки — повод для человека');
  assert.ok(rows(db)[0].detail.startsWith(SERIES_PENDING_PREFIX), 'ранняя строка не принята');
  assert.equal(rows(db)[0].status, 'unmapped');
  db.close();
});

test('серия: сообщение через 61 минуту — новая серия', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  for (const m of rows(db)) ago(db, m.id, 61);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.equal(message(db).detail, SERIES_PENDING_PREFIX + 'не пришли: Глюкоза (2), Мочевина (3)');
  assert.deepEqual(rows(db).slice(0, 2).map((m) => m.status), ['unmapped', 'unmapped'], 'старые строки серии не приняты задним числом');
  db.close();
});

test('серия: в пределах 60 минут — та же серия', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  for (const m of rows(db)) ago(db, m.id, 59);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'applied');
  db.close();
});

test('серия: строка, «Отклонённая» человеком, не переводится в applied', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  const first = message(db);
  resolveMessage(db, first.id);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'applied', 'значение отклонённой строки в бланке — серия полна');
  const again = db.prepare('SELECT * FROM lab_device_messages WHERE id = ?').get(first.id);
  assert.equal(again.status, 'unmapped', 'строку тронул человек — серия её не трогает');
  assert.equal(again.detail, first.detail);
  db.close();
});

test('серия: всё в одном сообщении (руководство, с. 23) — applied сразу', () => {
  const db = chem();
  const raw = BS('2', 'test2', '5').replace(/\rOBX.*$/, '\rOBX|1|NM|2|test2|5|g/ml|-||||F\rOBX|2|NM|3|test3|10|g/ml|-||||F\rOBX|3|NM|102|calctest1|15|g/ml|-||||F');
  ingestMessage(db, raw, '10.0.0.40', 1);
  assert.equal(message(db).status, 'applied');
  assert.equal(message(db).detail, '');
  db.close();
});

test('серия: D7 — по выданному бланку superseded, серия не считается', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  db.prepare("UPDATE lab_results SET verified_by = NULL, verified_at = '2026-10-01T10:00:00Z' WHERE visit_service_id = 123").run();
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'superseded');
  assert.equal(blank(db)['Мочевина'], undefined, 'выданный отчёт пациента не переписывается');
  assert.ok(rows(db)[0].detail.startsWith(SERIES_PENDING_PREFIX), 'ранняя строка серии не принята выданным');
  db.close();
});

test('серия: сообщения второго прибора той же модели — в той же серии', () => {
  const db = chem();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'BS-200 (2)','mindray-bs-200')").run();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.41', 2);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.deepEqual(rows(db).map((m) => m.status), ['applied', 'applied', 'applied']);
  db.close();
});

test('серия: строка, остановленная до бланка («панель не привязана»), в серию не входит', () => {
  const db = chem();
  db.prepare('UPDATE lab_panels SET device_id = NULL WHERE id = 5').run();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  assert.match(message(db).detail, /не привязана к анализатору/);
  db.prepare('UPDATE lab_panels SET device_id = 1 WHERE id = 5').run();
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.equal(message(db).detail, SERIES_PENDING_PREFIX + 'не пришли: Глюкоза (2)', 'значение первого сообщения в бланк не легло');
  assert.equal(blank(db)['Глюкоза'], undefined);
  db.close();
});

test('серия: строка, заполненная по пересчёту, но не записанная в бланк, — «не пришла»', () => {
  // Глюкоза пришла, когда её код ещё не был подтверждён, и в бланк не легла
  // (D4); потом человек подтвердил код. Серия верит бланку, а не пересчёту.
  const db = chem({ unconfirmed: ['GLU'] });
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  db.prepare("UPDATE lab_panel_analytes SET device_code_confirmed = 1 WHERE code = 'GLU'").run();
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /не пришли: Глюкоза \(2, в бланк не записано\)/);
  db.close();
});

test('серия: ручная привязка — новая строка входит в серию и, принятая серией, помнит «привязано вручную»', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5', { label: 'LAB-999999' }), '10.0.0.40', 1);
  assert.equal(message(db).status, 'unmatched');
  ingestMessage(db, message(db).raw, '10.0.0.40', 1, { touch: false, sampleIdOverride: 123 });
  const manual = message(db);
  assert.equal(manual.detail, SERIES_PENDING_PREFIX + 'не пришли: Мочевина (3), Расчётный (102); привязано вручную');
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  const after = db.prepare('SELECT * FROM lab_device_messages WHERE id = ?').get(manual.id);
  assert.equal(after.status, 'applied');
  assert.equal(after.detail, 'принято серией (сообщение № ' + message(db).id + '); привязано вручную');
  db.close();
});

test('прибор без oneTestPerMessage (BC-5300): правило прежнее — по сообщению, без «ждём»', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1', 1);
  assert.equal(message(db).status, 'unmapped');
  assert.equal(message(db).detail, 'не пришли: Гемоглобин (HGB)');
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'HGB', '142')]), '127.0.0.1', 1);
  assert.equal(message(db).detail, 'не пришли: Лейкоциты (WBC)', 'серии нет: каждое сообщение — само по себе');
  db.close();
});
