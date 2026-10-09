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
import { lisMessageAttach } from '../services/rpc/lis.js';   // LIS_VENDOR_EXACT_V1 — «Привязать» тем же RPC, что у экрана

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

// LIS_VENDOR_EXACT_V1 (N1) — раньше второе сообщение молча меняло черновик
// (6.1 → 7.2; приёмка: WBC 5.40 → 14.20 чужой пробирки, ни строки в лотке).
// Теперь значение прибора в черновике не меняется молча: сообщение — в лоток
// «повтор…», а принять новые значения — «Привязать» (номер называет человек).
// Строк в бланке по-прежнему одна на показатель.
test('повторный прогон обновляет ту же строку, а не дублирует', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '7.2')]), '127.0.0.1');
  assert.deepEqual(results(db).map((r) => r.value), ['6.1'], 'другое значение прибора — не молча: в черновике прежнее');
  assert.match(message(db).detail, /^повтор: значения отличаются от уже записанных \(Лейкоциты 6\.1 → 7\.2\)/);
  ingestMessage(db, message(db).raw, '127.0.0.1', null, { touch: false, sampleIdOverride: 123 });
  const rows = results(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, '7.2', '«Привязать» принимает новое значение — той же строкой');
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
  // LIS_VENDOR_EXACT_V1 — BS-240 пишет пробу по-своему (провод mindray-chem):
  // MSH-3/4 пусты, штрихкод в OBR-2, OBR-3 — его внутренний номер.
  const bs240 = ['MSH|^~\\&|||||20260528122129||ORU^R01|3|P|2.3.1', 'OBR|1|LAB-000123|1|^|N',
    'OBX|1|NM|WBC|Leukocytes|6.100000|10*9/L|-|N|||F||6.100000|20260528122129|||0||'].join('\r');
  ingestMessage(db, bs240, '127.0.0.1', 2);
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
  // Ревью R5, п. 2 — «подтверждено человеком для прибора 1» — отметкой: без
  // неё вставка — «ни для какого прибора».
  lines.forEach(([code, name, dc], i) => {
    db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed, device_code_confirmed_device_id, device_code_confirmed_epoch)
                VALUES (5, ?, ?, '', ?, ?, ?, ?, ?)`).run(code, name, i + 1, dc, unconfirmed.includes(code) ? 0 : 1, unconfirmed.includes(code) ? null : 1, unconfirmed.includes(code) ? null : 0);   // эпоха 0: ревью R6, п. 1
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
  // Ревью R2, п. 5 — повторная передача — справка у того сообщения, которое
  // повторило значение (второе), а не у каждого следующего.
  assert.equal(message(db).detail, 'серия из 4 сообщений принята');
  assert.equal(rows(db)[1].detail, 'принято серией (сообщение № ' + message(db).id + ')');
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
  // LIS_VENDOR_EXACT_V1 (D3; приёмка BS-200 T8) — «не пришли» у прибора с
  // серией — по бланку: Глюкозу записало первое сообщение той же пробирки, и
  // называть её «не пришедшей» — неправда.
  assert.equal(message(db).detail, 'не пришли: Расчётный (102); не подтверждено: 3 (test3)');
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
  // Ревью R2, п. 5 — бланк полон (Глюкоза, Мочевина): ожидание ранней строки
  // кончилось, она принята; спор — в строке второго сообщения, в лотке.
  assert.equal(rows(db)[0].status, 'applied');
  assert.deepEqual(tray(db).map((m) => m.id), [message(db).id]);
  db.close();
});

// Ревью R2, п. 5 (случай B) — «не пришли» судится по бланку, а не по окну:
// строки, пришедшие раньше 60 минут, лежат в бланке — бланк полон, и все
// ждущие строки этого заказа приняты, в том числе старше окна. Раньше все три
// строки ждали, а последняя говорила «не пришли: Глюкоза».
test('серия: сообщения в −61, −30 и 0 минут — бланк полон: принято, ждущие строки приняты все', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  ago(db, rows(db)[0].id, 61);
  ago(db, rows(db)[1].id, 30);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'applied');
  assert.equal(message(db).detail, 'серия из 2 сообщений принята', 'в окне — два сообщения');
  assert.deepEqual(rows(db).map((m) => m.status), ['applied', 'applied', 'applied']);
  assert.deepEqual(tray(db), []);
  db.close();
});

test('серия: строка бланка не пришла ни в окне, ни раньше — «ждём» по бланку', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  ago(db, rows(db)[0].id, 61);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.equal(message(db).detail, SERIES_PENDING_PREFIX + 'не пришли: Мочевина (3)', 'Глюкоза в бланке — не «не пришла»');
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

// Ревью R2, п. 1 — у BS-200 «та же модель» не действует (номер теста свой у
// каждого прибора; тест «R2 п. 1» ниже). У A1000 код позиции — код
// производителя (206 = витамин B12), и серия идёт по модели, как прежде.
test('серия: сообщения второго прибора той же модели (A1000) — в той же серии', () => {
  const db = chem({ profile: 'autobio-autolumo-a1000', lines: [['B12', 'Витамин B12', '206'], ['FER', 'Ферритин', '207']] });
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'A1000 (2)','autobio-autolumo-a1000')").run();
  const A = (code, v) => ['MSH|^~\\&|A1000|Autolumo|||20261001101500||ORU^R01|1|P|2.3.1||||0||ASCII|||',
    'PID|||SYN-PAT-1', 'OBR|1|LAB-000123|||', `OBX|1|NM|1^X|${code}|1^${v}|pg/mL|||||F`].join('\r');   // LIS_VENDOR_EXACT_V1 — PID: у пробы пациента он есть (без PID «по тесту» — контроль, wire.js)
  ingestMessage(db, A('206', '390.9'), '10.0.0.40', 1);
  assert.ok(message(db).detail.startsWith(SERIES_PENDING_PREFIX), message(db).detail);
  ingestMessage(db, A('207', '52.1'), '10.0.0.41', 2);
  assert.deepEqual(rows(db).map((m) => m.status), ['applied', 'applied']);
  assert.deepEqual(blank(db), { 'Витамин B12': '390.9', 'Ферритин': '52.1' });
  db.close();
});

test('серия: строка, остановленная до бланка («панель не привязана»), в серию не входит', () => {
  const db = chem();
  db.prepare('UPDATE lab_panels SET device_id = NULL WHERE id = 5').run();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  assert.match(message(db).detail, /не привязана к анализатору/);
  db.prepare('UPDATE lab_panels SET device_id = 1 WHERE id = 5').run();
  // Ревью R4, п. A — подтверждения даны для прибора 1, и панель снова на нём:
  // подтверждать заново нечего (триггер R3 их снимал).
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

// ── LIS_REAL_ANALYZERS_V1 — ревью R2 ───────────────────────────────────────

// П. 5 (случай E) — один тест прогнали снова через 2 часа с другим числом.
// Раньше новое значение молча заменяло черновик, а строка говорила «ждём: не
// пришли: …». Теперь: значение прибора в бланке сменилось — «повтор», в лотке,
// в любом окне. Машина по-прежнему пишет в ЧЕРНОВИК (D6) — но смена видна.
test('R2 п. 5: тот же тест через 2 часа с другим числом — «повтор: было 5.1, в бланке 9.9», в лотке', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5.1'), '10.0.0.40', 1);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  for (const m of rows(db)) ago(db, m.id, 120);
  ingestMessage(db, BS('2', 'test2', '9.9'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'unmapped');
  assert.equal(message(db).detail, 'повтор: 2 (test2): было 5.1, в бланке 9.9');
  assert.equal(blank(db)['Глюкоза'], '9.9', 'D6: машина пишет в черновик');
  assert.deepEqual(tray(db).map((m) => m.id), [message(db).id]);
  db.close();
});

test('R2 п. 5: тот же тест через 2 часа с тем же числом — повторная передача, принято', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5.1'), '10.0.0.40', 1);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  for (const m of rows(db)) ago(db, m.id, 120);
  ingestMessage(db, BS('2', 'test2', '5.100000'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'applied');
  assert.equal(message(db).detail, 'повторная передача: 2 (test2)');
  db.close();
});

test('R2 п. 5: значение, набранное руками (не прибором), — не «повтор»: D6, как прежде', () => {
  const db = chem();
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, source) VALUES (123,'Глюкоза','4.0','manual')").run();
  ingestMessage(db, BS('2', 'test2', '5.1'), '10.0.0.40', 1);
  assert.ok(message(db).detail.startsWith(SERIES_PENDING_PREFIX), message(db).detail);
  assert.ok(!/повтор/.test(message(db).detail));
  assert.equal(blank(db)['Глюкоза'], '5.1');
  db.close();
});

// П. 6 — спор, отклонённый человеком, не всплывает снова.
test('R2 п. 6: «повтор», отклонённый человеком, следующими сообщениями не повторяется', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5.1'), '10.0.0.40', 1);
  ingestMessage(db, BS('2', 'test2', '5.4'), '10.0.0.40', 1);
  const dispute = message(db);
  assert.match(dispute.detail, /повтор: 2 \(test2\): было 5\.1, в бланке 5\.4/);
  resolveMessage(db, dispute.id);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  assert.ok(!/повтор/.test(message(db).detail), 'следующее сообщение спор не тянет: ' + message(db).detail);
  ingestMessage(db, BS('2', 'test2', '5.1'), '10.0.0.40', 1);
  assert.ok(!/повтор/.test(message(db).detail), 'те же два числа того же теста — спор уже разобран человеком: ' + message(db).detail);
  ingestMessage(db, BS('2', 'test2', '7.7'), '10.0.0.40', 1);
  assert.match(message(db).detail, /повтор: 2 \(test2\): было 5\.1, в бланке 7\.7/, 'новое число — новый спор');
  db.close();
});

// П. 9 — серия не растёт без предела: стоимость приёма была квадратичной.
test('R2 п. 9: больше 200 сообщений по заказу за час — серия не считается, сообщение в лотке с причиной', () => {
  const db = chem();
  const raw = BS('2', 'test2', '5');
  const ins = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, sample_id, visit_service_id, status, detail) VALUES (1, '10.0.0.40', ?, 'LAB-000123', 123, 'unmapped', 'x')");
  db.transaction(() => { for (let i = 0; i < 200; i++) ins.run(raw); })();
  const t = Date.now();
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  assert.ok(Date.now() - t < 2000);
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /больше 200 сообщений/);
  assert.equal(blank(db)['Мочевина'], '10', 'значение легло, как у любого сообщения');
  db.close();
});

// П. 1 — у BS-200 номер теста свой у каждого прибора (ItemID.ini): «2» у
// второго BS-200 — другой тест. Подмена «та же модель» здесь положила бы
// креатинин второго прибора в строку «Глюкоза» панели первого.
test('R2 п. 1: два BS-200 — проба второго в панель первого не ложится: лоток с причиной, бланк не тронут', () => {
  const db = chem();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'BS-200 (2)','mindray-bs-200')").run();
  ingestMessage(db, BS('2', 'CREA', '88'), '10.0.0.41', 2);
  const m = message(db);
  assert.equal(m.status, 'unmatched');
  assert.equal(m.visit_service_id, 123, 'этикетка LAB- — заказ назван верно, не та только панель');
  assert.match(m.detail, /привязана к другому анализатору той же модели \(«BS-200»\)/);
  assert.match(m.detail, /номер теста свой у каждого прибора/);
  assert.deepEqual(blank(db), {});
  db.close();
});

test('R2 п. 1: BS-200 — серия только своего прибора', () => {
  const db = chem();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'BS-200 (2)','mindray-bs-200')").run();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.41', 2);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.equal(message(db).detail, 'серия из 3 сообщений принята', 'сообщение второго прибора — не член серии');
  db.close();
});

test('R2 п. 1: гематология (коды производителя) — подмена «та же модель» прежняя', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'Гематология 2','mindray-bc-5300')").run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142', { unit: 'g/L' })]), '10.0.0.12', 2);
  assert.equal(message(db).status, 'applied');
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R3 ───────────────────────────────────────

// П. 1 — прибор сообщения неизвестен (строку удалили — «Удалить» ставит
// device_id = NULL; потолок находок; строку звонка удалили посреди кадра), а
// панель кормит BS-200: номер теста свой у каждого прибора, и «2» неизвестного
// прибора могло быть креатинином. Ничего не пишется — лоток с причиной.
test('R3 п. 1: прибор неизвестен, панель кормит BS-200 — ничего не записано, лоток с причиной', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'CREA', '88'), '10.0.0.41', null, { touch: false, sampleIdOverride: 123 });
  const m = message(db);
  assert.equal(m.status, 'unmatched');
  assert.match(m.detail, /прибор этого сообщения неизвестен/);
  assert.match(m.detail, /номер теста свой у каждого прибора/);
  assert.deepEqual(blank(db), {}, 'креатинин неизвестного прибора не лёг в «Глюкозу»');
  db.close();
});

test('R3 п. 1: прибор неизвестен, панель с кодами производителя (BC-5300) — пишется, как прежде', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142')]), '10.0.0.12', null);
  assert.equal(message(db).status, 'applied');
  assert.equal(results(db).length, 2);
  db.close();
});

// П. 2 — текст лотка у второго BS-200: не «заведите свою панель» (у услуги
// панель одна — lab_panels.service_id UNIQUE), а что делать в обоих случаях.
test('R3 п. 2: лоток у другого BS-200 — что делать, если адрес сменился, и если это второй прибор', () => {
  const db = chem();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'BS-200 (2)','mindray-bs-200')").run();
  ingestMessage(db, BS('2', 'CREA', '88'), '10.0.0.41', 2);
  const d = message(db).detail;
  assert.match(d, /если это тот же анализатор с новым адресом — в «Лаборатория → Панели» выберите для панели этот прибор и заново подтвердите номера тестов, потом «Привязать»/);
  assert.match(d, /если это второй BS-200 — номера тестов у него свои: его результаты вносятся вручную или нужна отдельная услуга со своей панелью/);
  assert.ok(!/заведите для него свою/.test(d), d);
  db.close();
});

// П. 5 — отклонённый спор узнавался подстрокой: «было 5.1, в бланке 5.45»
// гасил новый «5.1 → 5.4».
test('R3 п. 5: отклонённый спор «5.1 → 5.45» не гасит новый «5.1 → 5.4»', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5.1'), '10.0.0.40', 1);
  ingestMessage(db, BS('2', 'test2', '5.45'), '10.0.0.40', 1);
  assert.match(message(db).detail, /было 5\.1, в бланке 5\.45/);
  resolveMessage(db, message(db).id);
  ingestMessage(db, BS('2', 'test2', '5.1'), '10.0.0.40', 1);
  assert.ok(!/повтор/.test(message(db).detail), 'те же два числа — разобрано: ' + message(db).detail);
  ingestMessage(db, BS('2', 'test2', '5.4'), '10.0.0.40', 1);
  assert.match(message(db).detail, /повтор: 2 \(test2\): было 5\.1, в бланке 5\.4(;|$)/, '«5.4» — не «5.45»: новый спор');
  db.close();
});

test('R3 п. 5: отклонённый спор теста «12» не гасит спор теста «2» с теми же числами', () => {
  const db = chem({ lines: [['GLU', 'Глюкоза', '2'], ['UREA', 'Мочевина', '12']] });
  // Подпись одна и та же («GLU»): «2 (GLU): было 5.1…» — подстрока «12 (GLU): было 5.1…».
  ingestMessage(db, BS('12', 'GLU', '5.1'), '10.0.0.40', 1);
  ingestMessage(db, BS('12', 'GLU', '5.4'), '10.0.0.40', 1);
  resolveMessage(db, message(db).id);
  ingestMessage(db, BS('2', 'GLU', '5.1'), '10.0.0.40', 1);
  ingestMessage(db, BS('2', 'GLU', '5.4'), '10.0.0.40', 1);
  assert.match(message(db).detail, /повтор: 2 \(GLU\): было 5\.1, в бланке 5\.4/);
  db.close();
});

// П. 6 — бланк судился по значениям любого возраста: глюкоза, ждущая с
// прошлого понедельника, и сегодняшние мочевина и расчётный — «серия
// принята», лоток пуст. Значения прибора старше суток бланк не дополняют, и
// ждущие строки старше суток не переводятся — они остаются «серия не дошла».
test('R3 п. 6: глюкоза трёхдневной давности + сегодняшние мочевина и расчётный — не «принято»; старая строка ждёт', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  const old = message(db);
  ago(db, old.id, 3 * 24 * 60);
  db.prepare("UPDATE lab_results SET entered_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-3 days') WHERE visit_service_id = 123").run();
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'unmapped');
  assert.equal(message(db).detail, SERIES_PENDING_PREFIX + 'не пришли: Глюкоза (2)');
  const again = db.prepare('SELECT * FROM lab_device_messages WHERE id = ?').get(old.id);
  assert.equal(again.status, 'unmapped', 'строка старше суток не принята задним числом');
  assert.ok(again.detail.startsWith(SERIES_PENDING_PREFIX));
  db.close();
});

test('R3 п. 6: в пределах суток — по бланку, как в R2', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  const first = message(db);
  ago(db, first.id, 23 * 60);
  db.prepare("UPDATE lab_results SET entered_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-23 hours') WHERE visit_service_id = 123").run();
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'applied');
  assert.equal(db.prepare('SELECT status FROM lab_device_messages WHERE id = ?').get(first.id).status, 'applied');
  db.close();
});

// П. 10 — «390.10» и «390.1» — одно число: не «повтор». В бланке — как пришло.
test('R3 п. 10: A1000 «390.10», потом «390.1» — повторная передача, а не повтор; в бланке значение как пришло', () => {
  const db = chem({ profile: 'autobio-autolumo-a1000', lines: [['B12', 'Витамин B12', '206']] });
  const A = (v) => ['MSH|^~\\&|A1000|Autolumo|||20261001101500||ORU^R01|1|P|2.3.1||||0||ASCII|||',
    'PID|||SYN-PAT-1', 'OBR|1|LAB-000123|||', `OBX|1|NM|1^X|206|1^${v}|pg/mL|||||F`].join('\r');   // LIS_VENDOR_EXACT_V1 — PID: у пробы пациента он есть (без PID «по тесту» — контроль, wire.js)
  ingestMessage(db, A('390.10'), '10.0.0.41', 1);
  assert.equal(blank(db)['Витамин B12'], '390.10');
  ingestMessage(db, A('390.1'), '10.0.0.41', 1);
  assert.equal(message(db).status, 'applied');
  assert.equal(message(db).detail, 'серия из 2 сообщений принята; повторная передача: 206 (X)');
  assert.equal(blank(db)['Витамин B12'], '390.1', 'D6 — пишется как пришло');
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R4 ───────────────────────────────────────

// П. A — подтверждение сопоставления помнит, для какого прибора оно дано
// (lab_panel_analytes.device_code_confirmed_device_id, мигр. 233). Номер теста
// свой у каждого прибора, если codesPerInstrument у ЛЮБОГО из: профиль строки
// отправителя, профиль строки прибора панели, модель, которой называет себя
// сообщение (MSH-3/4), модель, которой называл себя прибор панели. Тогда
// значения пишет только прибор панели и только в строки, подтверждённые для
// него. Прочие профили — как прежде: та же модель кормит панель, отметка не
// читается.
// LIS_VENDOR_EXACT_V1 — расположение полей BS-240 (руководство BS-360E/
// BS-240Pro/BS-240E, с. 16, 32–33): штрихкод в OBR-2, внутренний номер прибора
// в OBR-3, Channel No. в OBX-3, имя теста в OBX-4.
const BS240 = (n, value) => ['MSH|^~\\&|BS-240|Mindray|||20261001101500||ORU^R01|42|P|2.3.1',
  'OBR|1|LAB-000123|1|^|N', `OBX|1|NM|${n}|test${n}|${value}|umol/L|-|N|||F||${value}|20261001101500|||0||`].join('\r');

test('R4 п. A (дыра a): строку BS-200 панели переименовали в BS-240 — проба другого прибора «BS-240» в её бланк не идёт', () => {
  const db = chem();
  // Прибор панели — BS-200 (так он называл себя), но в «Анализаторах» его
  // модель сменили на BS-240. Второй прибор заведён как BS-240 и шлёт «2».
  db.prepare("UPDATE lab_devices SET profile = 'mindray-bs-240', sending_app = 'Mindray', sending_facility = 'BS-200E' WHERE id = 1").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (4,'BS-240','mindray-bs-240')").run();
  ingestMessage(db, BS240('2', '88'), '10.0.0.44', 4);
  const m = message(db);
  assert.equal(m.status, 'unmatched');
  assert.match(m.detail, /номер теста свой у каждого прибора/);
  assert.match(m.detail, /в «Анализаторах» прибор «BS-200» заведён как BS-240, а называет себя BS-200 — исправьте модель прибора/);
  assert.deepEqual(blank(db), {}, '«2» другого прибора не легло в «Глюкозу»');
  // Свой прибор панели (тот же, переименованный) — пишет, как пишал.
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  assert.equal(blank(db)['Глюкоза'], '5');
  db.close();
});

test('R4 п. A (дыра b): прибор неизвестен, панель на строке BS-240, сообщение — «Mindray|BS-200E» — ничего не записано', () => {
  const db = chem();
  db.prepare("UPDATE lab_devices SET profile = 'mindray-bs-240' WHERE id = 1").run();
  ingestMessage(db, BS('2', 'CREA', '88'), '10.0.0.41', null, { touch: false, sampleIdOverride: 123 });
  const m = message(db);
  assert.equal(m.status, 'unmatched');
  assert.match(m.detail, /прибор этого сообщения неизвестен/);
  assert.deepEqual(blank(db), {});
  db.close();
});

test('R4 п. A (дыра c): два BS-200 заведены как BS-240 — проба второго в панель первого не идёт', () => {
  const db = chem();
  db.prepare("UPDATE lab_devices SET profile = 'mindray-bs-240' WHERE id = 1").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'BS-240 (2)','mindray-bs-240')").run();
  ingestMessage(db, BS('2', 'CREA', '88'), '10.0.0.41', 2);
  const m = message(db);
  assert.equal(m.status, 'unmatched');
  assert.match(m.detail, /привязана к другому анализатору той же модели \(«BS-200»\)/);
  assert.match(m.detail, /в «Анализаторах» прибор «BS-240 \(2\)» заведён как BS-240, а называет себя BS-200 — исправьте модель прибора/);
  assert.deepEqual(blank(db), {});
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  assert.equal(blank(db)['Глюкоза'], '5', 'свой прибор панели пишет');
  db.close();
});

test('R4 п. A (дыра d): панель перепривязали к другому BS-200 — подтверждения первого не применяются, лоток говорит, что делать', () => {
  const db = chem();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'BS-200 (2)','mindray-bs-200')").run();
  db.prepare('UPDATE lab_panels SET device_id = 2 WHERE id = 5').run();
  ingestMessage(db, BS('2', 'CREA', '88'), '10.0.0.41', 2);
  const m = message(db);
  assert.equal(m.status, 'unmapped');
  assert.match(m.detail, /не подтверждено: 2 \(CREA\)/);
  assert.match(m.detail, /подтверждено для другого прибора — подтвердите заново в «Лаборатория → Панели»: Глюкоза \(2\)/);
  assert.deepEqual(blank(db), {});
  // Прежний прибор панели больше не её.
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  assert.equal(message(db).status, 'unmatched');
  assert.deepEqual(blank(db), {});
  // Подтвердили заново (снять и поставить галочку) — для прибора 2.
  db.prepare("UPDATE lab_panel_analytes SET device_code_confirmed = 0 WHERE code = 'GLU'").run();
  db.prepare("UPDATE lab_panel_analytes SET device_code_confirmed = 1 WHERE code = 'GLU'").run();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.41', 2);
  assert.equal(blank(db)['Глюкоза'], '5');
  // Мочевина и расчётный подтверждены для прибора 1 — для прибора 2 они «не
  // подтверждены», и бланк их не ждёт (правило владельца: заполнена каждая
  // ПОДТВЕРЖДЁННАЯ строка); придёт их значение — лоток с причиной.
  assert.equal(message(db).status, 'applied', message(db).detail);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.41', 2);
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /подтверждено для другого прибора — подтвердите заново в «Лаборатория → Панели»: Мочевина \(3\)$/);
  assert.equal(blank(db)['Мочевина'], undefined);
  db.close();
});

test('R4 п. A: подтверждение, данное до мигр. 233 (без прибора), у BS-200 — «не подтверждено», не применяется', () => {
  const db = chem();
  db.prepare('UPDATE lab_panel_analytes SET device_code_confirmed_device_id = NULL WHERE panel_id = 5').run();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  assert.deepEqual(blank(db), {});
  assert.match(message(db).detail, /подтверждено для другого прибора/);
  db.close();
});

test('R4 п. A: коды производителя (BC-5300) — отметка не читается: та же модель и прежние подтверждения пишут, как прежде', () => {
  const db = fresh();
  db.prepare('UPDATE lab_panel_analytes SET device_code_confirmed_device_id = NULL WHERE panel_id = 5').run();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'Гематология 2','mindray-bc-5300')").run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142')]), '10.0.0.12', 2);
  assert.equal(message(db).status, 'applied');
  assert.equal(results(db).length, 2);
  db.close();
});

// П. B — у значения прибора в бланке — номер строки лотка, которая его
// записала (lab_results.source_message_id): «Привязать» снимает по нему.
test('R4 п. B: значение прибора помнит строку лотка, которая его записала; следующее сообщение — своё', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5.1'), '10.0.0.40', 1);
  const first = message(db);
  const src = () => db.prepare("SELECT source_message_id AS s FROM lab_results WHERE visit_service_id = 123 AND parameter = 'Глюкоза'").get().s;
  assert.equal(src(), first.id);
  ingestMessage(db, BS('2', 'test2', '5.4'), '10.0.0.40', 1);
  assert.equal(src(), message(db).id, 'переписал — его значение');
  db.close();
});

// П. C — статус заказа до того, как прибор поставил «результаты внесены».
test('R4 п. C: прибор запоминает статус заказа до «результаты внесены»; поверх «результаты внесены» не переписывает', () => {
  const db = chem();
  db.prepare("UPDATE visit_services SET status = 'collected' WHERE id = 123").run();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  const st = () => ({ ...db.prepare('SELECT status, lis_status_before FROM visit_services WHERE id = 123').get() });
  assert.deepEqual(st(), { status: 'resulted', lis_status_before: 'collected' });
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  assert.deepEqual(st(), { status: 'resulted', lis_status_before: 'collected' });
  db.close();
});

// П. D — разобранный спор хранится структурой (lab_device_messages.disputes:
// [{code, a, b}], значения без хвостовых нулей) и узнаётся по ней, а не по
// тексту журнала.
test('R4 п. D: спор «повтор» записан структурой; разобранный узнаётся по ней — и с «5.10» вместо «5.1»', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5.10'), '10.0.0.40', 1);
  ingestMessage(db, BS('2', 'test2', '5.40'), '10.0.0.40', 1);
  const dispute = message(db);
  assert.deepEqual(JSON.parse(dispute.disputes), [{ code: '2', a: '5.1', b: '5.4' }]);
  assert.equal(rows(db)[0].disputes, null, 'у сообщения без спора — пусто');
  resolveMessage(db, dispute.id);
  ingestMessage(db, BS('2', 'test2', '5.1'), '10.0.0.40', 1);
  assert.ok(!/повтор:/.test(message(db).detail), message(db).detail);
  ingestMessage(db, BS('2', 'test2', '5.4'), '10.0.0.40', 1);
  assert.ok(!/повтор:/.test(message(db).detail), 'те же два числа в любом порядке: ' + message(db).detail);
  db.close();
});

test('R4 п. D: текст спора в журнале разобранной строки без структуры спор не гасит', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5.1'), '10.0.0.40', 1);
  db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, visit_service_id, status, detail, resolved_at) VALUES (1, '10.0.0.40', 'MSH|', 123, 'unmapped', 'повтор: 2 (test2): было 5.1, в бланке 5.4', '2026-10-01T08:00:00Z')").run();
  ingestMessage(db, BS('2', 'test2', '5.4'), '10.0.0.40', 1);
  assert.match(message(db).detail, /повтор: 2 \(test2\): было 5\.1, в бланке 5\.4/);
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R5, п. 4 ─────────────────────────────────
// LIS_VENDOR_EXACT_V1 (D0) — в бланке десятичная запятая стала точкой (и у
// mindray-chem хвостовые нули срезаны): «5,10» — «5.1». Раньше значение
// ложилось «как пришло», текстом без числа, и окно результатов его не показывало.
test('R5 п. 4: «5,10», потом «5.1» — повторная передача, а не спор; в бланке — число с точкой', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5,10'), '10.0.0.40', 1);
  assert.equal(blank(db)['Глюкоза'], '5.1', 'запятая — точка, нули срезаны (D0)');
  assert.equal(db.prepare("SELECT numeric_value FROM lab_results WHERE parameter = 'Глюкоза'").get().numeric_value, 5.1);
  ingestMessage(db, BS('2', 'test2', '5.1'), '10.0.0.40', 1);
  assert.ok(!/повтор:/.test(message(db).detail), message(db).detail);
  assert.match(message(db).detail, /повторная передача: 2 \(test2\)/);
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R6, п. 1 ─────────────────────────────────
// Вкладка «Панели», открытая ДО смены адреса BS-200, сохраняет и заново шлёт
// отметку прибора 1 — триггер адреса был бы отменён, и другой BS-200 по
// новому адресу писал бы креатинин в «Глюкозу». Подтверждение несёт эпоху
// кодов прибора, которую видел экран; смена адреса её увеличивает.
test('R6 п. 1: адрес BS-200 сменили, старая вкладка сохранила прежнюю отметку — в бланк не идёт; подтвердили заново — идёт', () => {
  const db = chem();
  db.prepare("UPDATE lab_devices SET host = '10.0.0.40' WHERE id = 1").run();
  db.prepare("UPDATE lab_devices SET host = '10.0.0.77' WHERE id = 1").run();
  assert.equal(db.prepare('SELECT code_epoch AS e FROM lab_devices WHERE id = 1').get().e, 1);
  // Старая вкладка: правка панели, вставка строк с отметкой 1 и эпохой 0, удаление прежних.
  const old = db.prepare('SELECT * FROM lab_panel_analytes WHERE panel_id = 5').all();
  for (const r of old) {
    db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed, device_code_confirmed_device_id, device_code_confirmed_epoch)
                VALUES (5, ?, ?, '', ?, ?, 1, 1, 0)`).run(r.code, r.name, r.sort_order, r.device_code);
    db.prepare('DELETE FROM lab_panel_analytes WHERE id = ?').run(r.id);
  }
  ingestMessage(db, BS('2', 'CREA', '88'), '10.0.0.77', 1);
  assert.deepEqual(blank(db), {}, 'креатинин прибора по новому адресу не лёг в «Глюкозу»');
  assert.match(message(db).detail, /подтверждено для другого прибора — подтвердите заново в «Лаборатория → Панели»: Глюкоза \(2\)/);
  // Подтвердили заново на свежем экране — эпоха 1.
  db.prepare("UPDATE lab_panel_analytes SET device_code_confirmed_epoch = 1 WHERE panel_id = 5 AND code = 'GLU'").run();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.77', 1);
  assert.equal(blank(db)['Глюкоза'], '5');
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R7, п. 1 ─────────────────────────────────
// Ворота лаборатории (INPATIENT_MONEY_FIX_V1, правило владельца) — те же, что
// у ручного ввода (rpc/lab.js saveLabResults): результат принимается только у
// заказа «ждёт забора», «проба взята», «в работе», «результаты внесены» или
// «выдан». Прибор их обходил с первого выпуска LIS: проба с этикеткой
// неоплаченного, отменённого или возвращённого заказа писала значения и
// переводила заказ в «результаты внесены» — после чего открывался и ручной
// ввод. Теперь такая проба — в лоток, и не пишется ничего.
test('R7 п. 1: неоплаченный заказ — прибор ничего не пишет; лоток «заказ ещё не оплачен…», строка с заказом (этикетка LAB-)', () => {
  const db = fresh();
  db.prepare("UPDATE visit_services SET status = 'added' WHERE id = 123").run();
  assert.equal(ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142')]), '127.0.0.1', 1), 'AA');
  const m = message(db);
  assert.equal(m.status, 'unmatched');
  assert.equal(m.visit_service_id, 123);
  assert.equal(m.detail, 'заказ ещё не оплачен — результат прибора можно «Привязать» после оплаты');
  assert.equal(results(db).length, 0);
  assert.equal(order(db).status, 'added', 'касса закрыта, как была');
  db.close();
});

test('R7 п. 1: отменённый и возвращённый заказ — ничего не пишется, лоток называет причину', () => {
  for (const [st, why] of [['cancelled', 'заказ отменён'], ['refunded', 'по заказу возврат']]) {
    const db = fresh();
    db.prepare('UPDATE visit_services SET status = ? WHERE id = 123').run(st);
    ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142')]), '127.0.0.1', 1);
    assert.deepEqual([message(db).status, message(db).detail], ['unmatched', why], st);
    assert.equal(results(db).length, 0, st);
    assert.equal(order(db).status, st, st);
    db.close();
  }
});

test('R7 п. 1: выданный бланк — superseded, как прежде', () => {
  const db = fresh();
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = 123").run();
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, verified_at) VALUES (123, 'Лейкоциты', '5.0', '2026-10-01T08:00:00Z')").run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1', 1);
  assert.equal(message(db).status, 'superseded');
  assert.equal(results(db)[0].value, '5.0');
  db.close();
});

test('R7 п. 1: серия BS-200 — заказ отменили посреди серии: третье сообщение ничего не пишет, ждущие строки не переводятся', () => {
  const db = chem();
  ingestMessage(db, BS('2', 'test2', '5'), '10.0.0.40', 1);
  ingestMessage(db, BS('3', 'test3', '10'), '10.0.0.40', 1);
  const waiting = rows(db).map((r) => r.id);
  db.prepare("UPDATE visit_services SET status = 'cancelled' WHERE id = 123").run();
  ingestMessage(db, BS('102', 'calctest1', '15'), '10.0.0.40', 1);
  assert.deepEqual([message(db).status, message(db).detail], ['unmatched', 'заказ отменён']);
  assert.equal(blank(db)['Расчётный'], undefined);
  for (const id of waiting) assert.equal(db.prepare('SELECT status FROM lab_device_messages WHERE id = ?').get(id).status, 'unmapped', 'ждущие не приняты');
  db.close();
});

// Стационар: анализ лежащего пациента — обычная строка визита (очередь
// лаборатории — visit_services); в очередь её отпускает касса, плательщик
// (счёт организации) или долг — как всякую. Отпущенная (queued и дальше)
// принимает прибор, как прежде.
test('R7 п. 1: анализ пациента в стационаре, отпущенный в очередь счётом плательщика, — прибор пишет, как прежде', () => {
  const db = fresh();
  db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (40, 3, 'admitted')").run();
  db.prepare("INSERT INTO payers (id, name) VALUES (7, 'Страховая')").run();
  db.prepare("INSERT INTO invoices (id, patient_id, status, payer_id, total_amount) VALUES (900, 3, 'unpaid', 7, 100)").run();
  db.prepare('INSERT INTO invoice_items (id, invoice_id) VALUES (901, 900)').run();
  db.prepare("UPDATE visit_services SET status = 'queued', invoice_item_id = 901 WHERE id = 123").run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142')]), '127.0.0.1', 1);
  assert.equal(message(db).status, 'applied');
  assert.equal(results(db).length, 2);
  assert.equal(order(db).status, 'resulted');
  db.close();
});

// ── LIS_VENDOR_EXACT_V1 — D5: «нет результата» Mindray не пишется ───────────
// Кадр BS-240E (2026, расположение полей настоящей записи; значения
// синтетические): штрихкод в OBR-2, Channel No. в OBX-3, имя в OBX-4, OBX-13 —
// исходное значение. В сообщении два теста: глюкоза посчитана, мочевина — нет
// («-268435455.000000»; так BS-240 пишет «нет результата», запись 2017 г.).
const BS240E = (obx) => ['MSH|^~\&|||||20260528122129||ORU^R01|3|P|2.3.1',
  'PID|1|||||||O|||||||||||||||||||||||',
  'OBR|1|LAB-000123|1|^|N|20260528115302|20260528115240|20260528115240||1^1||||20260528115240|Serum',
  ...obx].join('\r');

test('D5: −268435455 не пишется в бланк и не стирает набранное руками; лоток называет код и показывает OBX-13', () => {
  const db = chem({ profile: 'mindray-bs-240', lines: [['GLU', 'Глюкоза', 'Glu-G'], ['UREA', 'Мочевина', 'UREA']] });
  // Лаборант уже набрал мочевину руками (черновик).
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, numeric_value, flag, source) VALUES (123, 'Мочевина', '6.2', 6.2, 'normal', 'manual')").run();
  assert.equal(ingestMessage(db, BS240E([
    'OBX|1|NM|Glu-G|Glucose (GOD-POD Method)|5.123400|mmol/L|-|N|||F||5.123400|20260528122129|||0||',
    'OBX|2|NM|UREA|Urea|-268435455.000000||-|N|||F||0.000000|19000101000000|||0||',
  ]), '10.0.0.42', 1), 'AA');
  assert.deepEqual(blank(db), { 'Глюкоза': '5.1234', 'Мочевина': '6.2' }, '«нет результата» не легло и черновик не стёрло');
  const urea = db.prepare("SELECT * FROM lab_results WHERE parameter = 'Мочевина'").get();
  assert.deepEqual([urea.numeric_value, urea.source], [6.2, 'manual']);
  const m = message(db);
  assert.equal(m.status, 'unmapped', 'в лоток: строка бланка не заполнена прибором');
  assert.equal(m.detail, 'не пришли: Мочевина (UREA, прибор: нет результата «-268435455.000000», OBX-13 «0.000000» — для сверки, в бланк не пишется)');
  db.close();
});

test('D5: −100000000 c числом в OBX-13 — в бланк не идёт ни то, ни другое; качественное «+-» пишется, как прежде', () => {
  const db = chem({ profile: 'mindray-bs-240', lines: [['ALT', 'АЛТ', 'ALT'], ['HCG', 'ХГЧ', 'HCG']] });
  ingestMessage(db, BS240E([
    'OBX|1|NM|ALT|ALT|-100000000.0|U/L|-|N|||F||73.7|20260528122129|||0||',
    'OBX|2|ST|HCG|hCG|+-||-|N|||F|||20260528122129|||0||',
  ]), '10.0.0.42', 1);
  assert.deepEqual(blank(db), { 'ХГЧ': '+-' });
  assert.match(message(db).detail, /^не пришли: АЛТ \(ALT, прибор: нет результата «-100000000\.0», OBX-13 «73\.7» — для сверки, в бланк не пишется\)$/);
  db.close();
});

// ── LIS_VENDOR_EXACT_V1 — D0, D9: AutoLumo A1000 — число, флаг, флаги прибора ─
// Кадр — вывод кодировщика программы клиники AutoLumo1000.exe 1.0.7 (лист A1000,
// §3; settle, находка 1): OBX-2 всегда CE, OBX-3 = OBX-4 = код теста, OBX-5 =
// RLU^результат~, OBX-6/7/8 пусты, флаги прибора — только в NTE-3 (2-е
// повторение) перед OBX. Раньше значение писалось текстом без numeric_value, и
// флаг выходил «Норма» при любом диапазоне клиники: высокий АФП печатался
// нормой.
const A1000 = (value, flags = '') => ['MSH|^~\&|||||20261005120000||ORU^R01|5|P|2.3.1|261005120000123',
  'PID|||SYN-PAT-1', 'OBR|1|LAB-000123|7764|SYSID-SYN', `NTE|||LOT-SYN~${flags}~AFP~107~~RACK-SYN~1`,
  `OBX|10455|CE|107|107|41765^${value}~||||||F|||2026/10/05 12:00:00`].join('\r');
const afp = (db) => db.prepare("SELECT value, numeric_value, flag FROM lab_results WHERE visit_service_id = 123 AND parameter = 'АФП'").get();
function a1000Clinic() {
  const db = chem({ profile: 'autobio-autolumo-a1000', lines: [['AFP', 'АФП', '107']] });
  db.prepare('UPDATE lab_panel_analytes SET ref_low = 0, ref_high = 10').run();   // диапазон клиники, нг/мл
  return db;
}

test('D0: A1000 — значение пишется числом: numeric_value и флаг по диапазону клиники; запятая — точка', () => {
  const db = a1000Clinic();
  assert.equal(ingestMessage(db, A1000('12,5'), '10.0.0.41', 1), 'AA');
  assert.deepEqual(afp(db), { value: '12.5', numeric_value: 12.5, flag: 'high' }, 'высокий АФП — «Выше», а не «Норма»');
  assert.equal(message(db).status, 'applied');
  ingestMessage(db, A1000('4.17'), '10.0.0.41', 1);
  assert.deepEqual(afp(db), { value: '4.17', numeric_value: 4.17, flag: 'normal' });
  db.close();
});

test('D9: A1000 — ORH: «>предел» и «Выше»; ORL: «<» и «Ниже»; число не выдумывается', () => {
  const db = a1000Clinic();
  ingestMessage(db, A1000('1210', 'ORH'), '10.0.0.41', 1);
  assert.deepEqual(afp(db), { value: '>1210', numeric_value: null, flag: 'high' });
  ingestMessage(db, A1000('0,6', 'ORL'), '10.0.0.41', 1);
  assert.deepEqual(afp(db), { value: '<0.6', numeric_value: null, flag: 'low' });
  db.close();
});

// LIS_VENDOR_EXACT_V1 — было «PEX-CEX» — в лоток. Решение владельца
// 2026-10-06, п. 5 (analyzer-research\fix\DECISIONS.md): CEX, PEX, LEX —
// предупреждения о сроках, они не мешают (тест ниже); в лоток — только ошибка
// измерения. Сочетание — настоящее, из записей A1000 клиники (5 из 949).
test('D9: A1000 — ошибка измерения (ERR, QNR…) — в бланк не пишется, в лоток «флаги прибора: …»', () => {
  const db = a1000Clinic();
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, numeric_value, flag, source) VALUES (123, 'АФП', '3.3', 3.3, 'normal', 'manual')").run();
  ingestMessage(db, A1000('4.17', 'ERR-QNR-CEX-ORL'), '10.0.0.41', 1);
  assert.deepEqual(afp(db), { value: '3.3', numeric_value: 3.3, flag: 'normal' }, 'набранное руками не стёрто');
  const m = message(db);
  assert.equal(m.status, 'unmapped');
  assert.equal(m.detail, 'не пришли: АФП (107, флаги прибора: ERR-QNR-CEX-ORL)');
  db.close();
});

// LIS_VENDOR_EXACT_V1 (D9; решение владельца 2026-10-06, п. 5) — у A1000 клиники
// 832 из 949 результатов несут CEX («calibration curve … is expired»), многие —
// ещё PEX/LEX (сроки набора): раньше ни один такой результат в бланк не ложился,
// а A1000 по MSA-4 отмечал его «Accepted» и не повторял. Сочетания — настоящие
// (realtest\verify\a1000\reports\flags-decoded.txt).
test('D9: A1000 — CEX, CEX-PEX, CEX-LEX-PEX пишутся числом с флагом по диапазону клиники; CEX-ORH-OVR-PEX — «>предел» и «Выше»; CEX-LEX-ORL-PEX — «<» и «Ниже»', () => {
  const db = a1000Clinic();
  assert.equal(ingestMessage(db, A1000('12,5', 'CEX'), '10.0.0.41', 1), 'AA');
  assert.deepEqual(afp(db), { value: '12.5', numeric_value: 12.5, flag: 'high' }, 'CEX не мешает: число и «Выше» по диапазону клиники');
  assert.equal(message(db).status, 'applied');
  ingestMessage(db, A1000('4.17', 'CEX-PEX'), '10.0.0.41', 1);
  assert.deepEqual(afp(db), { value: '4.17', numeric_value: 4.17, flag: 'normal' });
  ingestMessage(db, A1000('4,2', 'CEX-LEX-PEX'), '10.0.0.41', 1);
  assert.deepEqual(afp(db), { value: '4.2', numeric_value: 4.2, flag: 'normal' });
  ingestMessage(db, A1000('1210', 'CEX-ORH-OVR-PEX'), '10.0.0.41', 1);
  assert.deepEqual(afp(db), { value: '>1210', numeric_value: null, flag: 'high' }, 'за пределом измерения — сам предел со знаком');
  ingestMessage(db, A1000('0,6', 'CEX-LEX-ORL-PEX'), '10.0.0.41', 1);
  assert.deepEqual(afp(db), { value: '<0.6', numeric_value: null, flag: 'low' });
  db.close();
});

test('D0: десятичная запятая — на любом проводе: в бланке точка и число (BC-5300, провод default)', () => {
  const db = fresh({ refLow: 4, refHigh: 9 });
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '9,81')]), '127.0.0.1');
  const r = results(db)[0];
  assert.deepEqual([r.value, r.numeric_value, r.flag], ['9.81', 9.81, 'high']);
  db.close();
});

// D0 — флаг без основания. Пустой флаг прибора и «N» без его диапазона (CL-900i
// пишет N всегда) — не основание для «Норма»: правило отдаёт null.
test('D0: resultFlag — основание флага: диапазон клиники, иначе флаг прибора; без основания — null', async () => {
  const { resultFlag } = await import('./ingest.js');
  assert.equal(resultFlag({ num: 12, refLow: 0, refHigh: 10 }), 'high', 'диапазон клиники');
  assert.equal(resultFlag({ num: 5, refLow: 0, refHigh: 10, abnormal: 'H' }), 'normal', 'инвариант 3: клиника бьёт прибор');
  assert.equal(resultFlag({ num: null, abnormal: '' }), null, 'текст без флага прибора — основания нет');
  assert.equal(resultFlag({ num: 5, abnormal: '' }), null, 'число без диапазона клиники и без флага — основания нет');
  assert.equal(resultFlag({ num: null, abnormal: 'N', deviceRange: '-' }), null, '«N» без диапазона прибора — не основание');
  assert.equal(resultFlag({ num: null, abnormal: 'N', deviceRange: '' }), null);
  assert.equal(resultFlag({ num: null, abnormal: 'N', deviceRange: '4.00-10.00' }), 'normal', '«N» по своему диапазону');
  assert.equal(resultFlag({ num: null, abnormal: 'H' }), 'high');
  assert.equal(resultFlag({ num: null, abnormal: 'L' }), 'low');
  assert.equal(resultFlag({ num: null, abnormal: 'LL' }), 'critical');
  assert.equal(resultFlag({ num: null, abnormal: 'A' }), 'abnormal');
});

// Схема не даёт хранить «нет флага»: lab_results.flag NOT NULL DEFAULT 'normal'
// CHECK (…) (мигр. 006). Приём пишет умолчание колонки — так же, как ручной
// ввод (rpc/lab.js saveLabResults). Если флаг станет допускать NULL, этот тест
// скажет, что запись без основания можно перестать подменять.
test('D0: без основания — в базе умолчание колонки «normal» (NOT NULL, мигр. 006), запись не срывается', () => {
  const db = chem({ profile: 'autobio-autolumo-a1000', lines: [['AFP', 'АФП', '107']] });
  assert.equal(db.prepare("SELECT \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('lab_results') WHERE name = 'flag'").get().nn, 1);
  assert.equal(ingestMessage(db, A1000('4.17'), '10.0.0.41', 1), 'AA');
  assert.deepEqual(afp(db), { value: '4.17', numeric_value: 4.17, flag: 'normal' });
  db.close();
});

// ── LIS_VENDOR_EXACT_V1 — D6: CL-900i — флаг из OBX-9, OBX-8 «N» не основание ─
// Host Interface Manual CL (с. 1-19–1-20): OBX-8 «Fixed as N» у КАЖДОГО
// результата, качественный ответ — в OBX-9 («Negative-, Positive+, weak
// positive+-»), OBX-7 «-». Раньше положительный HBsAg (ST, без числа) получал
// флаг «Норма» по OBX-8. Кадр — расположение полей руководства, значения
// синтетические.
const CL_HBS = (value, obx9) => ['MSH|^~\&|||||20261005101500||ORU^R01|3583|P|2.3.1||||0||ASCII|||',
  'PID|1|P1|||SYN^PAT||19800101|F|||||||||||||||||||||',
  'OBR|1|LAB-000123|10|^|N|20261005100000|20261005100000|20261005100000|||||||serum||||||||||||||||||||||||||',
  `OBX|1|ST|HBsAg|HBsAg|${value}|COI|-|N|${obx9}||F||${value}|20261005101400||admin|0|`].join('\r');
const hbs = (db) => db.prepare("SELECT value, numeric_value, flag, reference_range FROM lab_results WHERE visit_service_id = 123 AND parameter = 'HBsAg'").get();
const clClinic = (range) => {
  const db = chem({ profile: 'mindray-cl-900i', lines: [['HBS', 'HBsAg', 'HBsAg']] });
  if (range) db.prepare('UPDATE lab_panel_analytes SET ref_low = ?, ref_high = ?').run(...range);
  return db;
};

// LIS_VENDOR_EXACT_V1 (N1) — каждая проба — в своём бланке: второе другое
// значение прибора в тот же черновик теперь держится в лотке («повтор»).
test('D6: CL-900i — положительный HBsAg без диапазона клиники — «Отклонение», а не «Норма»', () => {
  const db = clClinic(null);
  assert.equal(ingestMessage(db, CL_HBS('5.320000', 'Positive+'), '10.0.0.43', 1), 'AA');
  assert.deepEqual(hbs(db), { value: '5.32', numeric_value: 5.32, flag: 'abnormal', reference_range: '' },
    'флаг — из OBX-9; индекс COI — число; OBX-7 «-» — не диапазон');
  db.close();
  const weak = clClinic(null);
  ingestMessage(weak, CL_HBS('0.120000', 'weak positive+-'), '10.0.0.43', 1);
  assert.equal(hbs(weak).flag, 'abnormal', 'слабоположительно — тоже отклонение');
  weak.close();
  const neg = clClinic(null);
  ingestMessage(neg, CL_HBS('0.120000', 'Negative-'), '10.0.0.43', 1);
  assert.deepEqual(hbs(neg), { value: '0.12', numeric_value: 0.12, flag: 'normal', reference_range: '' });
  neg.close();
});

test('D6: CL-900i — диапазон клиники для индекса COI работает; положительный ответ «нормой» не перекрывается', () => {
  const db = clClinic([0, 1]);
  ingestMessage(db, CL_HBS('5.320000', 'Positive+'), '10.0.0.43', 1);
  assert.equal(hbs(db).flag, 'high', 'диапазон клиники — «Выше»');
  const neg = clClinic([0, 1]);   // LIS_VENDOR_EXACT_V1 (N1) — другая проба — свой бланк
  ingestMessage(neg, CL_HBS('0.120000', 'Negative-'), '10.0.0.43', 1);
  assert.equal(hbs(neg).flag, 'normal');
  neg.close();
  // Диапазон клиники говорит «норма», прибор — «положительно»: положительный
  // результат «Нормой» не печатается.
  const wide = clClinic([0, 10]);
  ingestMessage(wide, CL_HBS('5.320000', 'Positive+'), '10.0.0.43', 1);
  assert.equal(hbs(wide).flag, 'abnormal');
  db.close(); wide.close();
});

// LIS_VENDOR_EXACT_V1 (D6, ревью) — BS-200: качественный ответ — в OBX-5
// («negative(-), positive(+), weak positive(+-)», HIM v5.0, с. 18), OBX-2 = ST.
// Раньше «+» ложился в бланк с флагом «Норма». Кадр — руководство BS-200 (с. 24).
const BS200_RF = (value) => ['MSH|^~\\&|Mindray|BS-200|||20261005101500||ORU^R01|17|P|2.3.1||||0||ASCII|||',
  'PID|1', 'OBR|1|LAB-000123|12|Mindray^BS-200|N||20261005101200||||||||serum',
  `OBX|1|ST|7|RF|${value}||-|N|||F|||20261005101200`].join('\r');
test('D6: BS-200 — «+» и «+-» в OBX-5 — «Отклонение», «-» — «Норма»; значение — текст, как пришло', () => {
  const db = chem({ lines: [['RF', 'Ревматоидный фактор', '7']] });
  const rf = () => db.prepare("SELECT value, numeric_value, flag FROM lab_results WHERE visit_service_id = 123 AND parameter = 'Ревматоидный фактор'").get();
  assert.equal(ingestMessage(db, BS200_RF('+'), '10.0.0.40', 1), 'AA');
  assert.deepEqual(rf(), { value: '+', numeric_value: null, flag: 'abnormal' }, 'положительный — не «Норма»');
  ingestMessage(db, BS200_RF('+-'), '10.0.0.40', 1);
  assert.deepEqual(rf(), { value: '+-', numeric_value: null, flag: 'abnormal' });
  ingestMessage(db, BS200_RF('-'), '10.0.0.40', 1);
  assert.deepEqual(rf(), { value: '-', numeric_value: null, flag: 'normal' });
  db.close();
});

test('D6: resultFlag — качественный ответ прибора', async () => {
  const { resultFlag } = await import('./ingest.js');
  assert.equal(resultFlag({ num: 5.3, qualitative: 'positive', abnormal: 'N', deviceRange: '-' }), 'abnormal');
  assert.equal(resultFlag({ num: 5.3, refLow: 0, refHigh: 1, qualitative: 'positive' }), 'high');
  assert.equal(resultFlag({ num: 5.3, refLow: 0, refHigh: 10, qualitative: 'positive' }), 'abnormal', 'клиника «норма» положительное не перекрывает');
  assert.equal(resultFlag({ num: 0.1, qualitative: 'negative', abnormal: 'N', deviceRange: '-' }), 'normal', 'основание — ответ прибора');
  assert.equal(resultFlag({ num: 0.9, refLow: 0, refHigh: 0.5, qualitative: 'negative' }), 'high', 'клиника бьёт «отрицательно» (инвариант 3)');
  assert.equal(resultFlag({ num: 2.35, abnormal: 'N', deviceRange: '-' }), null, 'CL: «N» без диапазона — не основание');
});

// ═══ LIS_VENDOR_EXACT_V1 — раунд 2: какая проба в какой заказ и что пишется ═══
// Решения владельца 2026-10-06 (analyzer-research\fix\DECISIONS.md) и остатки
// раунда 1 (fix\C1-RESULT.md). Кадры — по листам приборов и сценариям приёмки
// (acceptance\runs\…), значения синтетические.

const LAB = { role: 'lab' };   // «Привязать» — тем же RPC, что у экрана (rpc/lis.js lis_message_attach)
const formOf = (db, id) => Object.fromEntries(db.prepare('SELECT parameter, value FROM lab_results WHERE visit_service_id = ? ORDER BY id').all(id).map((r) => [r.parameter, r.value]));
const statusOf = (db, id) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;
const msgRow = (db, id) => db.prepare('SELECT * FROM lab_device_messages WHERE id = ?').get(id);

/**
 * Визит 55 пациента 3 с несколькими лабораторными услугами; у каждой услуги своя
 * панель, все панели кормит прибор 1 (подтверждено для него). services — { имя
 * услуги: [[код строки, имя строки, поле анализатора], …] }; orders — [[номер
 * заказа, имя услуги, статус = 'queued', визит = 55]]. Визит 56 — другой пациент.
 */
function visitClinic({ profile = 'mindray-cl-900i', services, orders }) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван'), (4,'Подставной Пациент')").run();
  db.prepare(`INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,strftime('%Y-%m-%dT%H:%M:%SZ','now'),'scheduled'),
              (56,4,strftime('%Y-%m-%dT%H:%M:%SZ','now'),'scheduled')`).run();
  db.prepare("INSERT INTO lab_devices (id, name, profile, transport, port, host) VALUES (1,'Прибор',?,'mllp',2575,'10.0.0.43')").run(profile);
  const svc = {};
  Object.entries(services).forEach(([name, rows], i) => {
    const id = 20 + i;
    svc[name] = id;
    db.prepare('INSERT INTO services (id, name, is_lab) VALUES (?, ?, 1)').run(id, name);
    db.prepare('INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (?, ?, ?, 1)').run(id, name, id);
    rows.forEach(([code, rowName, dc], k) => {
      db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed, device_code_confirmed_device_id, device_code_confirmed_epoch)
                  VALUES (?, ?, ?, '', ?, ?, 1, 1, 0)`).run(id, code, rowName, k + 1, dc);
    });
  });
  for (const [id, name, status = 'queued', visit = 55] of orders) {
    db.prepare('INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (?, ?, ?, ?)').run(id, visit, svc[name], status);
  }
  return db;
}

// CL-900i — «Chemiluminescence Immunoassay Analyzer Host Interface Manual»
// (2013-08), с. 1-25…1-27: одно сообщение на пробу со всеми тестами; OBR-2 —
// штрихкод, OBR-3 — номер пробы прибора, OBX-3 — Routine Channel No., OBX-4 —
// имя теста, OBX-13 — то же значение.
const CLT = (sample, tests, { id = 31 } = {}) => ['MSH|^~\\&|||||20261006101500||ORU^R01|' + id + '|P|2.3.1||||0||ASCII|||',
  'PID|1|1001|||SYN^PAT||19851001095133|M|||keshi|||||||||||||||beizhu|||||',
  `OBR|1|${sample}|10|^|Y|20261006100000|20261006100000|20261006100000|||||linchuangzhenduan|20261006100000|serum|lincyisheng|keshi||||||||3|||||||||||||||||||||||`,
  ...tests.map(([code, v, st = 'F'], i) => `OBX|${i + 1}|NM|${code}|${code}|${v}|pmol/L|-|N|||${st}||${v}|20261006101400||yishen|0|`)].join('\r');
const THYROID = { 'ТТГ': [['TSH', 'ТТГ', 'TSH']], 'Т4 свободный': [['FT4', 'Т4 свободный', 'FT4']], 'Т3 свободный': [['FT3', 'Т3 свободный', 'FT3']] };

// BS-200 — Host Interface Manual v5.0, пример с. 24 (приёмка runs\mindray-bs-200):
// по тесту в сообщении, OBR-2 — штрихкод, OBR-3 — номер пробы прибора,
// OBX-3 — «Код на ЛИС».
const BS2 = (sample, code, name, value, { id = 1 } = {}) => [
  `MSH|^~\\&|Mindray|BS-200|||20261006124717||ORU^R01|${id}|P|2.3.1||||0||ASCII|||`,
  'PID|1|900001|||Тестов Анализатор||19900101000000|M|||||||||||||||||||||||',
  `OBR|1|${sample}|7|Mindray^BS-200|N||20261006124717||||||||serum|||||||||||||||||||||||||||||||||`,
  `OBX|1|NM|${code}|${name}|${value}|mmol/L|-|N|||F|||20261006124717|||`].join('\r');

// A1000 «по тесту» — вывод кодировщика программы прибора клиники
// (realtest\a1000\runs\20261006-123254-en-US-ABDE\raw\01-A1): код — OBX-3 = OBX-4.
const A1T = (sample, code, reagent, value) => ['MSH|^~\\&|||||20261006123256||ORU^R01|5|P|2.3.1|261006123256638',
  'PID|||SYNTHETIC', `OBR|1|${sample}|7764|Autolumo 1000`, `NTE|||SYNLOT1~CEX~${reagent}~${code}~~R001~1`,
  `OBX|10455|CE|${code}|${code}|41765^${value}~||||||F|||2026/10/06 12:32:56`].join('\r');

// BC-5300 — пример руководства (OM13, прил. C; приёмка runs\mindray-bc-5300):
// номер пробы — OBR-3, OBX-3 «LOINC^ИМЯ^LN», строки режимов (IS) — справка.
const BC53 = (sample, { wbc = '5.40', hgb = '128', id = 1 } = {}) => [
  `MSH|^~\\&|BC-5300|Mindray|||20261006133432||ORU^R01|${id}|P|2.3.1||||||UNICODE`,
  'PID|1||T0001^^^^MR||Тестов^Анализатор||19900101000000|Мужской', 'PV1|1|Амбулаторно|Терапия^^12',
  `OBR|1||${sample}|00001^Automated Count^99MRC|||20261006133432|||||||||||||||||HM||||||||Лаборант`,
  'OBX|1|IS|08001^Take Mode^99MRC||O||||||F',
  ...(wbc == null ? [] : [`OBX|2|NM|6690-2^WBC^LN||${wbc}|10*9/L||N|||F`]),
  ...(hgb == null ? [] : [`OBX|3|NM|718-7^HGB^LN||${hgb}|g/L||N|||F`])].join('\r');

// ── D3 — решение владельца, п. 2: «Заполнить все» ─────────────────────────

test('D3: CL-900i — ТТГ, Т4 св. и Т3 св. тремя услугами, одна пробирка LAB- (ТТГ): заполнены все три; та же услуга другого пациента не тронута', () => {
  const db = visitClinic({ services: THYROID, orders: [[301, 'ТТГ'], [302, 'Т4 свободный'], [303, 'Т3 свободный'], [304, 'Т4 свободный', 'queued', 56]] });
  assert.equal(ingestMessage(db, CLT('LAB-000301', [['TSH', '2.350000'], ['FT4', '15.200000'], ['FT3', '4.100000']]), '10.0.0.43', 1), 'AA');
  const m = message(db);
  assert.equal(m.status, 'applied', m.detail);
  assert.equal(m.visit_service_id, 301, 'строка лотка — при заказе пробирки');
  assert.equal(m.detail, 'заказ № 301 «ТТГ»: принято; заказ № 302 «Т4 свободный»: принято; заказ № 303 «Т3 свободный»: принято');
  assert.deepEqual([formOf(db, 301), formOf(db, 302), formOf(db, 303)], [{ 'ТТГ': '2.35' }, { 'Т4 свободный': '15.2' }, { 'Т3 свободный': '4.1' }]);
  assert.deepEqual([301, 302, 303].map((id) => statusOf(db, id)), ['resulted', 'resulted', 'resulted']);
  assert.deepEqual(db.prepare('SELECT DISTINCT source_message_id s FROM lab_results').all().map((r) => r.s), [m.id], 'каждое значение помнит строку лотка');
  assert.deepEqual(formOf(db, 304), {}, 'другой пациент — другой визит: не тронут');
  assert.equal(statusOf(db, 304), 'queued');
  db.close();
});

test('D3: код подтверждён у двух других услуг визита — не угадываем: «неоднозначно», значение не записано никуда; «Привязать» к нужной', () => {
  const db = visitClinic({
    services: { ...THYROID, 'Тиреоидный профиль': [['FT4', 'Т4 свободный', 'FT4'], ['ATPO', 'Анти-ТПО', 'Anti-TPO']] },
    orders: [[301, 'ТТГ'], [302, 'Т4 свободный'], [305, 'Тиреоидный профиль']] });
  ingestMessage(db, CLT('LAB-000301', [['TSH', '2.350000'], ['FT4', '15.200000']]), '10.0.0.43', 1);
  const m = message(db);
  assert.equal(m.status, 'unmapped');
  assert.equal(m.detail, 'заказ № 301 «ТТГ»: принято; неоднозначно: FT4 (FT4) — у заказов № 302, № 305'
    + ' — код подтверждён у нескольких услуг визита, значение не записано; «Привязать» к нужному заказу');
  assert.deepEqual([formOf(db, 301), formOf(db, 302), formOf(db, 305)], [{ 'ТТГ': '2.35' }, {}, {}]);
  // Человек называет заказ — его код у названного заказа и берётся.
  const out = lisMessageAttach(db, { id: m.id, visit_service_id: 302 }, LAB);
  assert.equal(out.status, 'applied', out.detail);
  assert.deepEqual([formOf(db, 301), formOf(db, 302), formOf(db, 305)], [{ 'ТТГ': '2.35' }, { 'Т4 свободный': '15.2' }, {}]);
  db.close();
});

test('D3: код и у заказа пробирки, и у другого заказа визита (услуга заказана дважды) — берёт заказ пробирки', () => {
  const db = visitClinic({ services: THYROID, orders: [[301, 'ТТГ'], [306, 'ТТГ']] });
  ingestMessage(db, CLT('LAB-000301', [['TSH', '2.350000']]), '10.0.0.43', 1);
  assert.deepEqual([message(db).status, message(db).detail], ['applied', '']);
  assert.deepEqual([formOf(db, 301), formOf(db, 306)], [{ 'ТТГ': '2.35' }, {}]);
  db.close();
});

test('D3: услуга визита, которую кормит прибор другой модели, этим прибором не заполняется — «не использованы», как раньше', () => {
  const db = visitClinic({ services: THYROID, orders: [[301, 'ТТГ'], [302, 'Т4 свободный']] });
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'BS-240','mindray-bs-240')").run();
  db.prepare("UPDATE lab_panels SET device_id = 2 WHERE name = 'Т4 свободный'").run();
  ingestMessage(db, CLT('LAB-000301', [['TSH', '2.350000'], ['FT4', '15.200000']]), '10.0.0.43', 1);
  assert.deepEqual([message(db).status, message(db).detail], ['applied', 'не использованы: FT4 (FT4)']);
  assert.deepEqual(formOf(db, 302), {});
  db.close();
});

test('D3: другая услуга визита не оплачена — её значение не пишется, в лотке «заказ ещё не оплачен…»', () => {
  const db = visitClinic({ services: THYROID, orders: [[301, 'ТТГ'], [302, 'Т4 свободный', 'added']] });
  ingestMessage(db, CLT('LAB-000301', [['TSH', '2.350000'], ['FT4', '15.200000']]), '10.0.0.43', 1);
  const m = message(db);
  assert.equal(m.status, 'unmapped');
  assert.equal(m.detail, 'заказ № 301 «ТТГ»: принято; заказ № 302 «Т4 свободный»: заказ ещё не оплачен — результат прибора можно «Привязать» после оплаты');
  assert.deepEqual([formOf(db, 301), formOf(db, 302)], [{ 'ТТГ': '2.35' }, {}]);
  assert.equal(statusOf(db, 302), 'added', 'касса не обойдена');
  db.close();
});

test('D3: другая услуга визита уже выдана — значение не переписано, сообщение superseded (D7)', () => {
  const db = visitClinic({ services: THYROID, orders: [[301, 'ТТГ'], [302, 'Т4 свободный', 'completed']] });
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, source, verified_at) VALUES (302, 'Т4 свободный', '14', 'analyzer', '2026-10-06T08:00:00Z')").run();
  ingestMessage(db, CLT('LAB-000301', [['TSH', '2.350000'], ['FT4', '15.200000']]), '10.0.0.43', 1);
  const m = message(db);
  assert.equal(m.status, 'superseded');
  assert.equal(m.detail, 'заказ № 301 «ТТГ»: принято; заказ № 302 «Т4 свободный»: результат уже выдан; новый результат требует подтверждения человеком');
  assert.deepEqual([formOf(db, 301), formOf(db, 302)], [{ 'ТТГ': '2.35' }, { 'Т4 свободный': '14' }]);
  db.close();
});

test('D3: BS-200 по тесту в сообщении (приёмка T8) — Глюкоза и АЛТ отдельными услугами: АЛТ ложится в свою; «не пришли: Глюкоза» нет', () => {
  const db = visitClinic({ profile: 'mindray-bs-200', services: { 'Глюкоза': [['GLU', 'Глюкоза', 'GLU']], 'АЛТ': [['ALT', 'АЛТ', 'ALT']] },
    orders: [[22, 'Глюкоза'], [23, 'АЛТ']] });
  ingestMessage(db, BS2('LAB-000022', 'GLU', 'Glucose', '5.100000', { id: 1 }), '10.0.0.40', 1);
  assert.deepEqual([message(db).status, message(db).visit_service_id], ['applied', 22]);
  ingestMessage(db, BS2('LAB-000022', 'ALT', 'ALT', '85.300000', { id: 2 }), '10.0.0.40', 1);
  const alt = message(db);
  assert.equal(alt.status, 'applied', alt.detail);
  assert.equal(alt.visit_service_id, 23, 'сообщение одного теста — при заказе, который оно заполнило');
  assert.doesNotMatch(alt.detail, /не пришли/);
  assert.deepEqual([formOf(db, 22), formOf(db, 23)], [{ 'Глюкоза': '5.1' }, { 'АЛТ': '85.3' }]);
  assert.deepEqual([statusOf(db, 22), statusOf(db, 23)], ['resulted', 'resulted']);
  assert.deepEqual(tray(db), []);
  db.close();
});

test('D3: BS-200 — пока заказ пробирки ждёт свою строку, тест другой услуги ложится в неё; ожидание — в строке заказа пробирки', () => {
  const db = visitClinic({ profile: 'mindray-bs-200', services: { 'Биохимия': [['GLU', 'Глюкоза', 'GLU'], ['UREA', 'Мочевина', 'UREA']], 'АЛТ': [['ALT', 'АЛТ', 'ALT']] },
    orders: [[22, 'Биохимия'], [23, 'АЛТ']] });
  ingestMessage(db, BS2('LAB-000022', 'GLU', 'Glucose', '5.100000', { id: 1 }), '10.0.0.40', 1);
  const glu = message(db);
  assert.equal(glu.detail, SERIES_PENDING_PREFIX + 'не пришли: Мочевина (UREA)');
  ingestMessage(db, BS2('LAB-000022', 'ALT', 'ALT', '85.300000', { id: 2 }), '10.0.0.40', 1);
  assert.deepEqual([message(db).status, message(db).visit_service_id, message(db).detail], ['applied', 23, '']);
  assert.equal(msgRow(db, glu.id).status, 'unmapped', 'заказ пробирки всё ещё ждёт мочевину');
  ingestMessage(db, BS2('LAB-000022', 'UREA', 'Urea', '6.600000', { id: 3 }), '10.0.0.40', 1);
  assert.equal(message(db).status, 'applied', message(db).detail);
  assert.equal(msgRow(db, glu.id).status, 'applied', 'серия заказа пробирки дошла');
  assert.deepEqual(tray(db), []);
  db.close();
});

test('D3: A1000 по тесту — АФП и РЭА двумя услугами одной пробирки: каждый тест — в свою услугу', () => {
  const db = visitClinic({ profile: 'autobio-autolumo-a1000', services: { 'АФП': [['AFP', 'АФП', '107']], 'РЭА': [['CEA', 'РЭА', '102']] },
    orders: [[401, 'АФП'], [402, 'РЭА']] });
  ingestMessage(db, A1T('LAB-000401', '107', 'AFP', '4.17'), '10.0.0.41', 1);
  ingestMessage(db, A1T('LAB-000401', '102', 'CEA', '2.3'), '10.0.0.41', 1);
  assert.deepEqual([message(db).status, message(db).visit_service_id], ['applied', 402], message(db).detail);
  assert.deepEqual([formOf(db, 401), formOf(db, 402)], [{ 'АФП': '4.17' }, { 'РЭА': '2.3' }]);
  db.close();
});

test('D3: «Привязать» (номер называет человек) — пробирка заполняет и другие услуги визита', () => {
  const db = visitClinic({ services: THYROID, orders: [[301, 'ТТГ'], [302, 'Т4 свободный'], [303, 'Т3 свободный']] });
  ingestMessage(db, CLT('LAB-999999', [['TSH', '2.350000'], ['FT4', '15.200000'], ['FT3', '4.100000']]), '10.0.0.43', 1);
  const lost = message(db);
  assert.equal(lost.status, 'unmatched');
  const out = lisMessageAttach(db, { id: lost.id, visit_service_id: 302 }, LAB);
  assert.equal(out.status, 'applied', out.detail);
  assert.deepEqual([formOf(db, 301), formOf(db, 302), formOf(db, 303)], [{ 'ТТГ': '2.35' }, { 'Т4 свободный': '15.2' }, { 'Т3 свободный': '4.1' }]);
  db.close();
});

test('D3: прибор сообщения неизвестен (строку удалили) — чужие панели визита он не кормит', () => {
  const db = visitClinic({ services: THYROID, orders: [[301, 'ТТГ'], [302, 'Т4 свободный']] });
  ingestMessage(db, CLT('LAB-000301', [['TSH', '2.350000'], ['FT4', '15.200000']]), '10.0.0.43', null);
  // Без строки прибора кадр CL (MSH-3/4 пусты) читается общим проводом — нули не срезаны.
  assert.deepEqual([formOf(db, 301), formOf(db, 302)], [{ 'ТТГ': '2.350000' }, {}]);
  assert.match(message(db).detail, /не использованы: FT4/);
  db.close();
});

test('D3: «Привязать» строку пробирки к заказу другого пациента — её значения сняты и из других услуг визита', () => {
  const db = visitClinic({ services: THYROID, orders: [[301, 'ТТГ'], [302, 'Т4 свободный'], [303, 'Т3 свободный'], [304, 'Т4 свободный', 'queued', 56]] });
  // Т3 пришёл предварительным (P): проба в лотке, а ТТГ и Т4 уже в бланках.
  ingestMessage(db, CLT('LAB-000301', [['TSH', '2.350000'], ['FT4', '15.200000'], ['FT3', '4.100000', 'P']]), '10.0.0.43', 1);
  const m = message(db);
  assert.equal(m.status, 'unmapped', m.detail);
  assert.deepEqual([formOf(db, 301), formOf(db, 302)], [{ 'ТТГ': '2.35' }, { 'Т4 свободный': '15.2' }]);
  const out = lisMessageAttach(db, { id: m.id, visit_service_id: 304 }, LAB);   // человек: это пробирка другого пациента
  assert.equal(out.ok, true, out.detail);
  assert.deepEqual([formOf(db, 301), formOf(db, 302), formOf(db, 303)], [{}, {}, {}], 'значения пробирки ушли из всех бланков визита 55');
  assert.deepEqual(formOf(db, 304), { 'Т4 свободный': '15.2' });
  assert.match(out.detail, /снято из бланка заказа № 301: ТТГ, Т4 свободный \(заказ № 302\)/);
  assert.deepEqual([statusOf(db, 301), statusOf(db, 302)], ['queued', 'queued'], 'опустевшие заказы — снова у лаборатории');
  db.close();
});

// ── N1 — значение прибора в черновике молча не меняется ─────────────────────

test('N1: вторая пробирка с тем же номером (автоприращение, приёмка BC-5300 T6) меняет значения прибора — ничего не записано, в лотке «повтор…»; «Привязать» принимает', () => {
  const db = fresh();
  ingestMessage(db, BC53('LAB-000123', { wbc: '5.40', hgb: '128' }), '10.0.0.9', 1);
  const first = message(db);
  assert.equal(first.status, 'applied', first.detail);
  ingestMessage(db, BC53('LAB-000123', { wbc: '14.20', hgb: '146', id: 2 }), '10.0.0.9', 1);
  const m = message(db);
  assert.deepEqual([m.status, m.visit_service_id], ['unmapped', 123]);
  assert.equal(m.detail, 'повтор: значения отличаются от уже записанных (Лейкоциты 5.40 → 14.20, Гемоглобин 128 → 146)'
    + ' — проверьте пробу; принять новые значения — «Привязать»; не использованы: 08001^Take Mode^99MRC');
  assert.deepEqual(JSON.parse(m.disputes), [{ code: 'WBC', a: '5.4', b: '14.2' }, { code: 'HGB', a: '128', b: '146' }], 'спор — структурой, как у серии');
  assert.deepEqual(results(db).map((r) => [r.parameter, r.value, r.source_message_id]), [['Лейкоциты', '5.40', first.id], ['Гемоглобин', '128', first.id]],
    'черновик не тронут ни одной строкой');
  assert.deepEqual(tray(db).map((r) => r.id), [m.id]);
  const out = lisMessageAttach(db, { id: m.id, visit_service_id: 123 }, LAB);
  assert.equal(out.status, 'applied', out.detail);
  assert.deepEqual(results(db).map((r) => [r.parameter, r.value]), [['Лейкоциты', '14.20'], ['Гемоглобин', '146']], 'человек принял новые значения');
  assert.ok(msgRow(db, m.id).resolved_at, 'строка «повтор» разобрана');
  assert.deepEqual(tray(db), []);
  db.close();
});

test('N1: то же сообщение ещё раз (прибор не получил ACK) — повторная передача: ничего не меняется, в лоток не идёт', () => {
  const db = fresh();
  ingestMessage(db, BC53('LAB-000123'), '10.0.0.9', 1);
  const before = results(db).map((r) => [r.value, r.entered_at, r.source_message_id]);
  ingestMessage(db, BC53('LAB-000123', { wbc: '5.4', id: 2 }), '10.0.0.9', 1);   // «5.4» и «5.40» — одно число
  const m = message(db);
  assert.equal(m.status, 'applied', m.detail);
  assert.match(m.detail, /^повторная передача: 6690-2\^WBC\^LN, 718-7\^HGB\^LN/);
  assert.deepEqual(results(db).map((r) => [r.value, r.entered_at, r.source_message_id]), before, 'ничего не изменилось');
  assert.deepEqual(tray(db), []);
  db.close();
});

test('N1: записанное не меняется, а пустая строка бланка заполняется — принято', () => {
  const db = fresh();
  ingestMessage(db, BC53('LAB-000123', { hgb: null }), '10.0.0.9', 1);
  const first = message(db);
  assert.equal(first.detail, 'не пришли: Гемоглобин (HGB); не использованы: 08001^Take Mode^99MRC');
  ingestMessage(db, BC53('LAB-000123', { id: 2 }), '10.0.0.9', 1);
  const m = message(db);
  assert.equal(m.status, 'applied', m.detail);
  assert.deepEqual(results(db).map((r) => [r.parameter, r.value, r.source_message_id]), [['Лейкоциты', '5.40', first.id], ['Гемоглобин', '128', m.id]]);
  db.close();
});

// ── N2 — найденный, но не добавленный прибор в бланки не пишет ──────────────

test('N2: найденный, но не добавленный прибор (added = 0) в бланк не пишет — и как «та же модель» (приёмка BC-5300 N2, проба H)', () => {
  const db = fresh();
  db.prepare("UPDATE lab_devices SET host = '10.0.0.5' WHERE id = 1").run();   // добавленный BC-5300 — на своём адресе
  const found = ensureDevice(db, { sendingApp: 'BC-5300', sendingFacility: 'Mindray', peer: '10.0.0.55', port: 2575 }).device;
  assert.deepEqual([found.added, found.profile], [0, 'mindray-bc-5300'], 'находка той же модели, ещё не добавлена');
  ingestMessage(db, BC53('LAB-000123'), '10.0.0.55', found.id);
  const m = message(db);
  assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['unmatched', 123, 'LAB-000123'], 'этикетка LAB- — заказ назван, как у прочих отказов');
  assert.equal(m.detail, 'прибор ещё не добавлен — «Анализаторы» → «Добавить прибор» → «Найдены в сети» → «Добавить»');
  assert.deepEqual(results(db), [], 'бланк пациента не тронут');
  // «Привязать» до «Добавить» (приём с номером человека) — тоже нет: модель
  // находки — ещё догадка.
  ingestMessage(db, m.raw, '10.0.0.55', found.id, { touch: false, sampleIdOverride: 123 });
  const held = message(db);
  assert.deepEqual([held.status, held.visit_service_id, results(db).length], ['unmatched', 123, 0]);
  // Голый номер находки заказ не привязывает (номер прочитан проводом догадки).
  ingestMessage(db, BC53('000123', { id: 3 }), '10.0.0.55', found.id);
  assert.deepEqual([message(db).visit_service_id, message(db).detail], [null, m.detail]);
  const bare = message(db);
  // «Добавить» с моделью (lis_device_add) — дальше как у добавленного; та же
  // проба ещё раз — в бланке, и строки «не добавлен» этой пробы закрываются (п. 5).
  db.prepare('UPDATE lab_devices SET added = 1, model_confirmed = 1 WHERE id = ?').run(found.id);
  ingestMessage(db, BC53('LAB-000123', { id: 2 }), '10.0.0.55', found.id);
  const done = message(db);
  assert.equal(done.status, 'applied', done.detail);
  assert.equal(results(db).length, 2);
  for (const row of [m, held]) {
    assert.ok(msgRow(db, row.id).resolved_at, 'строка «не добавлен» этой пробы закрыта: № ' + row.id);
    assert.match(msgRow(db, row.id).detail, new RegExp('закрыто: бланк заказа № 123 заполнен сообщением № ' + done.id + '$'));
  }
  assert.equal(msgRow(db, bare.id).resolved_at, null, 'голый номер без заказа — остаётся человеку');
  db.close();
});

// ── п. 5 — устаревшие строки лотка закрываются, когда заказ заполнен ────────

test('п. 5: проба до настройки («панель … не привязана к анализатору») закрывается, когда та же проба после настройки заполнила бланк', () => {
  const db = fresh();
  db.prepare('UPDATE lab_panels SET device_id = NULL WHERE id = 5').run();
  ingestMessage(db, BC53('LAB-000123'), '10.0.0.9', 1);
  const pre = message(db);
  assert.equal(pre.detail, 'панель «ОАК» не привязана к анализатору');
  db.prepare('UPDATE lab_panels SET device_id = 1 WHERE id = 5').run();
  ingestMessage(db, BC53('LAB-000123', { id: 2 }), '10.0.0.9', 1);
  const done = message(db);
  assert.equal(done.status, 'applied', done.detail);
  const after = msgRow(db, pre.id);
  assert.ok(after.resolved_at, 'строка до настройки снята с лотка');
  assert.equal(after.status, 'unmapped', 'статус — как был: строку закрыла проба, а не человек');
  assert.equal(after.detail, 'панель «ОАК» не привязана к анализатору; закрыто: бланк заказа № 123 заполнен сообщением № ' + done.id);
  assert.deepEqual(tray(db), []);
  db.close();
});

test('п. 5: частичная отправка CL-900i («Отправить незавершенные пробы») закрывается полной', () => {
  const db = chem({ profile: 'mindray-cl-900i', lines: [['TSH', 'ТТГ', 'TSH'], ['FT4', 'Т4 свободный', 'FT4']] });
  ingestMessage(db, CLT('LAB-000123', [['TSH', '2.350000']]), '10.0.0.43', 1);
  const part = message(db);
  assert.equal(part.detail, 'не пришли: Т4 свободный (FT4)');
  ingestMessage(db, CLT('LAB-000123', [['TSH', '2.350000'], ['FT4', '15.200000']], { id: 32 }), '10.0.0.43', 1);
  const full = message(db);
  assert.equal(full.status, 'applied', full.detail);
  assert.equal(msgRow(db, part.id).detail, 'не пришли: Т4 свободный (FT4); закрыто: бланк заказа № 123 заполнен сообщением № ' + full.id);
  assert.ok(msgRow(db, part.id).resolved_at);
  assert.deepEqual(tray(db), []);
  db.close();
});

test('п. 5 и D3: частичная отправка, легшая в другую услугу визита, закрывается, когда пробирка пришла целиком', () => {
  const db = visitClinic({ services: THYROID, orders: [[301, 'ТТГ'], [302, 'Т4 свободный']] });
  ingestMessage(db, CLT('LAB-000301', [['FT4', '15.200000']]), '10.0.0.43', 1);   // ТТГ ещё не посчитан
  const part = message(db);
  assert.equal(part.status, 'unmapped');
  assert.equal(part.detail, 'заказ № 301 «ТТГ»: не пришли: ТТГ (TSH); заказ № 302 «Т4 свободный»: принято');
  ingestMessage(db, CLT('LAB-000301', [['TSH', '2.350000'], ['FT4', '15.200000']], { id: 32 }), '10.0.0.43', 1);
  const full = message(db);
  assert.equal(full.status, 'applied', full.detail);
  assert.ok(msgRow(db, part.id).resolved_at, 'всё, что говорила ранняя строка, теперь в бланках');
  assert.deepEqual([formOf(db, 301), formOf(db, 302)], [{ 'ТТГ': '2.35' }, { 'Т4 свободный': '15.2' }]);
  assert.deepEqual(tray(db), []);
  db.close();
});

test('N1 и D3: значение прибора в другой услуге визита меняется — в неё не пишется ничего, проба в лотке; заказ пробирки заполнен', () => {
  const db = visitClinic({ services: THYROID, orders: [[301, 'ТТГ'], [302, 'Т4 свободный']] });
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, source) VALUES (302, 'Т4 свободный', '14.1', 'analyzer')").run();
  ingestMessage(db, CLT('LAB-000301', [['TSH', '2.350000'], ['FT4', '15.200000']]), '10.0.0.43', 1);
  const m = message(db);
  assert.equal(m.status, 'unmapped');
  assert.equal(m.detail, 'заказ № 301 «ТТГ»: принято; заказ № 302 «Т4 свободный»: повтор: значения отличаются от уже записанных'
    + ' (Т4 свободный 14.1 → 15.2) — проверьте пробу; принять новые значения — «Привязать»');
  assert.deepEqual([formOf(db, 301), formOf(db, 302)], [{ 'ТТГ': '2.35' }, { 'Т4 свободный': '14.1' }]);
  assert.deepEqual(JSON.parse(m.disputes), [{ code: 'FT4', a: '14.1', b: '15.2' }]);
  db.close();
});

test('п. 5: не закрываются — «повтор», строка другого заказа, другие значения, другой прибор', () => {
  // «повтор» (N1): спор разбирает человек.
  const a = fresh();
  ingestMessage(a, BC53('LAB-000123'), '10.0.0.9', 1);
  ingestMessage(a, BC53('LAB-000123', { wbc: '14.20', id: 2 }), '10.0.0.9', 1);
  const held = message(a);
  ingestMessage(a, BC53('LAB-000123', { id: 3 }), '10.0.0.9', 1);
  assert.equal(message(a).status, 'applied');
  assert.equal(msgRow(a, held.id).resolved_at, null, '«повтор» остаётся в лотке');
  a.close();

  // Строка другого заказа (другой пациент) — его заказ не заполнен.
  const b = fresh();
  b.prepare("INSERT INTO patients (id, full_name) VALUES (4,'Петров')").run();
  b.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (56,4,'2026-09-10T09:00:00Z','scheduled')").run();
  b.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (124,56,9,'in_progress')").run();
  ingestMessage(b, BC53('LAB-000124', { hgb: null }), '10.0.0.9', 1);
  const other = message(b);
  ingestMessage(b, BC53('LAB-000123'), '10.0.0.9', 1);
  assert.equal(msgRow(b, other.id).resolved_at, null, 'строка заказа 124 — не заказа 123');
  b.close();

  // До настройки пришли другие значения (другой прогон) — человек сверит сам.
  const c = fresh();
  c.prepare('UPDATE lab_panels SET device_id = NULL WHERE id = 5').run();
  ingestMessage(c, BC53('LAB-000123', { wbc: '6.10', hgb: '140' }), '10.0.0.9', 1);
  const pre = message(c);
  c.prepare('UPDATE lab_panels SET device_id = 1 WHERE id = 5').run();
  ingestMessage(c, BC53('LAB-000123', { id: 2 }), '10.0.0.9', 1);
  assert.equal(message(c).status, 'applied');
  assert.equal(msgRow(c, pre.id).resolved_at, null, 'значения ранней строки не те, что в бланке');
  c.close();

  // Строка другого прибора (второй BC-5300) — «того же прибора» нет.
  const d = fresh();
  d.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'Гематология 2','mindray-bc-5300')").run();
  ingestMessage(d, BC53('LAB-000123', { hgb: null }), '10.0.0.12', 2);
  const second = message(d);
  ingestMessage(d, BC53('LAB-000123'), '10.0.0.9', 1);
  assert.equal(message(d).status, 'applied');
  assert.equal(msgRow(d, second.id).resolved_at, null, 'строка второго прибора не закрывается первым');
  d.close();
});

// ── п. 6 — контроль качества к сопоставлению с пациентом не доходит ─────────

test('п. 6: контроль BS-200 (MSH-16 = 2, номер теста «7» в OBR-2), поданный в приём напрямую и с номером человека, — служебная строка; бланки не тронуты', () => {
  const db = chem({ lines: [['GLU', 'Глюкоза', '7']] });
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (7,55,9,'queued')").run();
  // Приёмка BS-200 T7 — вид руководства: MSH + OBR, OBR-2 — номер теста.
  const qc = ['MSH|^~\\&|Mindray|BS-200|||20261006124717||ORU^R01|18|P|2.3.1||||2||ASCII|||',
    'OBR|1|7|Glucose|Mindray^BS-200||20261006124717|||||||QC-N1|1111|20271231000000||M|5.000000|0.250000|5.10295|mmol/L|||||||||||||||||||||||||||'].join('\r');
  for (const opts of [{}, { touch: false, sampleIdOverride: 7 }]) {
    assert.equal(ingestMessage(db, qc, '10.0.0.40', 1, opts), 'AA');
    const m = message(db);
    assert.deepEqual([m.kind, m.status, m.visit_service_id, !!m.resolved_at], ['qc', 'unmatched', null, true], JSON.stringify(opts));
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results').get().c, 0);
  db.close();
});

test('п. 6: контроль гематологии (BC-5300 X-R, MSH-11 = Q; BC-20 L-J, OBR-4 00003^LJ QCR^99MRC) — мимо сопоставления и при прямом вызове приёма', () => {
  const db = fresh();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (6,55,9,'queued'), (3,55,9,'queued')").run();
  const xr = ['MSH|^~\\&|BC-5300|Mindray|||20081120171602||ORU^R01|1|Q|2.3.1||||||UNICODE', 'PID|1||6666666||||20080807235959',
    'OBR|1||6|00006^XR QCR^99MRC|||20080807142518|||||||||||||||||HM||||||||Operator', 'OBX|4|NM|6690-2^WBC^LN||7.10|10*9/L|||||F'].join('\r');
  const lj = ['MSH|^~\\&|||||20261006133432||ORU^R01|9|P|2.3.1||||||UNICODE', 'PID|1||LOT-SYN^^^^MR',
    'OBR|1||3|00003^LJ QCR^99MRC|||20261006133432|||||||||||||||||HM||||||||Admin', 'OBX|1|NM|6690-2^WBC^LN||7.20|10*9/L||N|||F'].join('\r');
  for (const [raw, n] of [[xr, 6], [lj, 3]]) {
    ingestMessage(db, raw, '10.0.0.9', 1);
    assert.deepEqual([message(db).kind, message(db).visit_service_id], ['qc', null], String(n));
    ingestMessage(db, raw, '10.0.0.9', 1, { touch: false, sampleIdOverride: n });
    assert.deepEqual([message(db).kind, message(db).visit_service_id], ['qc', null], n + ': и с номером человека');
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results').get().c, 0, 'значения контроля не легли ни в один бланк');
  db.close();
});

test('D3 и D7: заказ пробирки уже выдан — его значение не переписывается, другая услуга визита заполняется; сообщение superseded', () => {
  const db = visitClinic({ services: THYROID, orders: [[301, 'ТТГ', 'completed'], [302, 'Т4 свободный']] });
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, source, verified_at) VALUES (301, 'ТТГ', '2.1', 'analyzer', '2026-10-06T08:00:00Z')").run();
  ingestMessage(db, CLT('LAB-000301', [['TSH', '2.350000'], ['FT4', '15.200000']]), '10.0.0.43', 1);
  const m = message(db);
  assert.equal(m.status, 'superseded', 'новое значение к выданному бланку смотрит человек');
  assert.equal(m.detail, 'заказ № 301 «ТТГ»: результат уже выдан; новый результат требует подтверждения человеком; заказ № 302 «Т4 свободный»: принято');
  assert.deepEqual([formOf(db, 301), formOf(db, 302)], [{ 'ТТГ': '2.1' }, { 'Т4 свободный': '15.2' }]);
  // Тест только своей, выданной услуги — как прежде: superseded, без журнала по заказам.
  ingestMessage(db, CLT('LAB-000301', [['TSH', '2.400000']], { id: 33 }), '10.0.0.43', 1);
  assert.deepEqual([message(db).status, message(db).detail], ['superseded', 'результат уже выдан; новый результат требует подтверждения человеком']);
  db.close();
});

test('п. 5: A1000 (серия) — проба до настройки закрывается, когда та же проба после настройки легла в бланк (приёмка A1000, находка T5)', () => {
  const db = a1000Clinic();
  db.prepare('UPDATE lab_panels SET device_id = NULL WHERE id = 5').run();
  ingestMessage(db, A1000('4.17', 'CEX'), '10.0.0.41', 1);
  const pre = message(db);
  assert.match(pre.detail, /^панель «Биохимия» не привязана к анализатору$/);
  db.prepare('UPDATE lab_panels SET device_id = 1 WHERE id = 5').run();
  ingestMessage(db, A1000('4.17', 'CEX'), '10.0.0.41', 1);
  const done = message(db);
  assert.equal(done.status, 'applied', done.detail);
  assert.equal(msgRow(db, pre.id).detail, 'панель «Биохимия» не привязана к анализатору; закрыто: бланк заказа № 123 заполнен сообщением № ' + done.id);
  assert.ok(msgRow(db, pre.id).resolved_at);
  assert.deepEqual(tray(db), []);
  db.close();
});
