// receive.test.js — LIS_REAL_ANALYZERS_V1_SERVICE: один вход для сообщения
// прибора. Вид по заголовку → приём пробы или служебная строка, и ответ прибору.
//
// Служебное (контроль качества, калибровка, запрос рабочего списка) хранится
// целиком (инвариант 2), но в бланк не идёт, в лоток не попадает и номер пробы
// у него не ищется: у QC BS-200 в OBR-2 стоит НОМЕР ТЕСТА (руководство, с. 16).
// Фикстуры — руководство BS-200 (Host Interface Manual v1.2), с. 24–28;
// Autobio — по драйверу LiveMachine AutoLumoHL7.cs, строки 193–263.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { receiveMessage } from './receive.js';
import { lisRecent } from '../services/rpc/lis.js';
import { readEnvelope } from './wire.js';
import { parseMessage } from './hl7.js';
import { getProfile } from './profiles/index.js';   // LIS_VENDOR_EXACT_V1 — вид ответа по профилю

const seg = (...s) => s.join('\r');
// Пустые поля в конце сегмента — для сравнения поле в поле; точный вид ответа —
// байт в байт (LIS_VENDOR_EXACT_V1).
const fieldsOf = (line) => { const f = line.split('|'); while (f.length && f[f.length - 1] === '') f.pop(); return f; };
// LIS_VENDOR_EXACT_V1 — CR после КАЖДОГО сегмента ответа, и последнего тоже.
const linesOf = (reply) => { const l = reply.split('\r'); assert.equal(l.pop(), '', 'ответ кончается CR'); return l; };

const BS200_QC = (ackType = '2') => seg(
  `MSH|^~\\&|Mindray|BS-200E|||20070720120202||ORU^R01|1|P|2.3.1||||${ackType}||ASCII|||`,
  'OBR|1|1|test1|Mindray^BS-200E||20070720120143|||||||QUAL1|1111|20080720000000||H|5.000000|2.000000|0.11029|g/ml|||||||||||||||||||||||||||',
);
const BS200_QRY = (qrd9 = 'OTH', barcode = '34567743') => seg(
  'MSH|^~\\&|Mindray|BS-200E|||20070723170707||QRY^Q02|1|P|2.3.1||||||ASCII|||',
  `QRD|20070723170707|R|D|1|||RD|${barcode}|${qrd9}|||T|`,
  'QRF|BS-200E|20070723170749|20070723170749|||RCT|COR|ALL||',
);
const AUTOBIO_QRY = seg(
  'MSH|^~\\&|A1000|Autolumo|||20261001101500||QRY^Q01|3|P|2.3.1',
  'QRD|20261001101500|R|D|7|||RD|LAB-000123|OTH|||T',
  'QRF|A1000|20261001000000|20261001101500|||RCT|COR|ALL',
);
const ORU = (obx = 'OBX|1|NM|WBC^^99MRC||6.1|10*9/L|||||F') => seg(
  'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1',
  'OBR|1||LAB-000001|00001^Automated Count^99MRC',
  obx,
);

/**
 * Клиника, где служебному сообщению легко было бы лечь не туда: заказ № 1 —
 * лабораторный, в работе, панель привязана к прибору и подтверждена. Номер
 * теста «1» из OBR-2 QC BS-200 совпадает с номером заказа.
 */
function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-10-01T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'Общий анализ крови',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (1,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile, transport, port) VALUES (1,'Гематология','mindray-bc-5300','mllp',2575)").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'ОАК',9,1)").run();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed)
              VALUES (5,'WBC','Лейкоциты','10^9/л',1,'WBC',1), (5,'T1','Тест 1','г/л',2,'test1',1)`).run();
  return db;
}

const last = (db) => db.prepare('SELECT * FROM lab_device_messages ORDER BY id DESC LIMIT 1').get();
const results = (db) => db.prepare('SELECT * FROM lab_results WHERE visit_service_id = 1').all();
const orderStatus = (db) => db.prepare('SELECT status FROM visit_services WHERE id = 1').get().status;
const tray = (db) => db.prepare('SELECT * FROM lab_device_messages WHERE resolved_at IS NULL').all();
const LAB = { role: 'lab' };

test('контроль качества BS-200 (MSH-16 = 2, с. 26–27): AA с MSH-16 эхом; строка qc, разрешена, без заказа; заказ № 1 не тронут', () => {
  const db = fresh();
  const out = receiveMessage(db, BS200_QC(), { peer: '10.0.0.40', deviceId: 1 });
  assert.equal(out.code, 'AA');
  assert.equal(out.kind, 'qc');
  const [mshLine, msa] = linesOf(out.reply);
  const f = fieldsOf(mshLine);
  assert.deepEqual([f[4], f[5], f[8], f[9], f[15], f[17]], ['Mindray', 'BS-200E', 'ACK^R01', '1', '2', 'ASCII'], 'с. 27: ответ на QC несёт MSH-16 = 2');
  // LIS_VENDOR_EXACT_V1 — сообщение назвало себя BS-200: вид руководства (с. 26).
  assert.equal(mshLine.split('|').length, 21, 'MSH до MSH-20 с хвостом «|ASCII|||»');
  assert.equal(msa, 'MSA|AA|1|Message accepted|||0|');

  const m = last(db);
  assert.equal(m.kind, 'qc');
  assert.equal(m.status, 'unmatched');
  assert.ok(m.resolved_at, 'служебная строка разрешена сразу — в лоток не попадает');
  assert.equal(m.visit_service_id, null, 'номер пробы у служебного не ищется: в OBR-2 — номер теста');
  assert.equal(m.sample_id, '');
  assert.equal(m.raw, BS200_QC(), 'инвариант 2: сохранено целиком');
  assert.equal(m.device_id, 1);
  assert.match(m.detail, /контроль качества/);
  assert.equal(results(db).length, 0, 'в бланк не идёт');
  assert.equal(orderStatus(db), 'in_progress', 'заказ № 1 не тронут');
  assert.equal(tray(db).length, 0, 'в «Необработанных» пусто');
  assert.ok(db.prepare('SELECT last_seen_at FROM lab_devices WHERE id = 1').get().last_seen_at, 'прибор на связи: это разобранное сообщение анализатора');
  assert.equal(lisRecent(db, {}, LAB).length, 0, 'утренний контроль не вытесняет из ленты пробы пациентов');
  db.close();
});

test('калибровка (MSH-16 = 1) — то же: строка calibration, разрешена, в бланк и ленту не идёт', () => {
  const db = fresh();
  const out = receiveMessage(db, BS200_QC('1'), { peer: '10.0.0.40', deviceId: 1 });
  assert.equal(out.code, 'AA');
  assert.equal(fieldsOf(linesOf(out.reply)[0])[15], '1');
  const m = last(db);
  assert.equal(m.kind, 'calibration');
  assert.ok(m.resolved_at);
  assert.equal(m.visit_service_id, null);
  assert.match(m.detail, /калибровка/);
  assert.equal(results(db).length, 0);
  assert.equal(lisRecent(db, {}, LAB).length, 0);
  db.close();
});

test('QRY^Q02 BS-200 (с. 27) → QCK^Q02 «заказов нет» (с. 28); строка query со штрихкодом, разрешена', () => {
  const db = fresh();
  const out = receiveMessage(db, BS200_QRY(), { peer: '10.0.0.40', deviceId: 1 });
  assert.equal(out.code, 'AA');
  assert.equal(out.kind, 'query');
  // LIS_VENDOR_EXACT_V1 — байт в байт (HIM v5.0, с. 27; manual-check §2.3):
  // «MSH|^~\&|||Manufacturer|Model|20070723170707||QCK^Q02|1|P|2.3.1||||||ASCII|||<CR>
  //  MSA|AA|1|Message accepted|||0|<CR>ERR|0|<CR>QAK|SR|NF|<CR>» — «If the sample of the bar code does not exist».
  const stamp = out.reply.split('|')[6];
  assert.equal(out.reply, `MSH|^~\\&|EASYMED|CLINIC|Mindray|BS-200E|${stamp}||QCK^Q02|1|P|2.3.1||||||ASCII|||\rMSA|AA|1|Message accepted|||0|\rERR|0|\rQAK|SR|NF|\r`);
  const m = last(db);
  assert.equal(m.kind, 'query');
  assert.equal(m.sample_id, '34567743', 'QRD-8 — для справки');
  assert.equal(m.visit_service_id, null);
  assert.ok(m.resolved_at);
  assert.equal(tray(db).length, 0);
  db.close();
});

test('QRY^Q02 с QRD-9 = CAN (отмена группового запроса, с. 34) — тот же QCK^Q02', () => {
  const db = fresh();
  const out = receiveMessage(db, BS200_QRY('CAN', ''), { peer: '10.0.0.40', deviceId: 1 });
  assert.equal(fieldsOf(linesOf(out.reply)[0])[8], 'QCK^Q02');
  assert.match(out.reply, /QAK\|SR\|NF/);
  assert.equal(last(db).kind, 'query');
  assert.match(last(db).detail, /отмен/);
  db.close();
});

test('QRY^Q01 Autobio → DSR^Q01: MSA AA, ERR|0, QAK|SR|NF, эхо QRD и QRF, без DSP', () => {
  const db = fresh();
  const out = receiveMessage(db, AUTOBIO_QRY, { peer: '10.0.0.41', deviceId: null });
  assert.equal(out.code, 'AA');
  const lines = linesOf(out.reply);
  assert.equal(fieldsOf(lines[0])[8], 'DSR^Q01');
  assert.equal(fieldsOf(lines[0])[9], '3');
  // LIS_VENDOR_EXACT_V1 — Autobio — длинный вид (декодер A1000 его принимает:
  // settle, табл. c); MSA-6 — целое, как он требует.
  assert.equal(lines[1], 'MSA|AA|3|Message accepted|||0|');
  assert.equal(lines[2], 'ERR|0|');
  assert.equal(lines[3], 'QAK|SR|NF|', '«нет данных» — по аналогии с QCK; проверить на приборе');
  assert.equal(lines[4], 'QRD|20261001101500|R|D|7|||RD|LAB-000123|OTH|||T');
  assert.equal(lines[5], 'QRF|A1000|20261001000000|20261001101500|||RCT|COR|ALL');
  assert.ok(!lines.some((l) => l.startsWith('DSP')), 'заказов Easy-Med не отдаёт');
  assert.equal(last(db).sample_id, 'LAB-000123');
  assert.equal(last(db).kind, 'query');
  assert.equal(results(db).length, 0);
  db.close();
});

// LIS_VENDOR_EXACT_V1 (D13) — было ACK^O01 AA («документа нет, проверить на
// приборе»). Документ есть: OM13 pdf 489–490 (mindray-bc-5300.md §5) — «заказов
// нет» = ORR^O02 с MSA|AR|<номер запроса>; BC-20 — так же (mindray-bc-20.md M14).
test('ORM^O01 гематологии Mindray → ORR^O02 MSA|AR «заказов нет» (OM13 pdf 490), короткий вид', () => {
  const db = fresh();
  const out = receiveMessage(db, 'MSH|^~\\&|BC-780|Mindray|||20261001090000||ORM^O01|9|P|2.3.1||||||UNICODE\rORC|RF||SampleID1||IP', { peer: '10.0.0.42' });
  assert.equal(out.code, 'AR');
  const [mshLine, msa] = linesOf(out.reply);
  assert.equal(fieldsOf(mshLine)[8], 'ORR^O02');
  assert.equal(fieldsOf(mshLine)[17], 'UNICODE');
  assert.equal(mshLine.split('|').length, 18, 'гематология — короткий заголовок (17 «|»), как в примере производителя');
  assert.equal(msa, 'MSA|AR|9');
  assert.equal(last(db).kind, 'query');
  assert.ok(last(db).resolved_at);
  db.close();
});

test('проба пациента идёт в приём, как прежде; ответ — ACK^R01 AA (гематология — короткий вид + CR)', () => {
  const db = fresh();
  const out = receiveMessage(db, ORU(), { peer: '10.0.0.9', deviceId: 1 });
  assert.equal(out.code, 'AA');
  assert.equal(out.kind, 'result');
  assert.equal(fieldsOf(linesOf(out.reply)[0])[8], 'ACK^R01');
  assert.equal(linesOf(out.reply)[1], 'MSA|AA|42|Message accepted|||0');
  const m = last(db);
  assert.equal(m.kind, 'result');
  assert.equal(m.visit_service_id, 1);
  assert.equal(m.resolved_at, null, 'проба с незаполненным бланком ждёт человека, как прежде');
  assert.equal(results(db)[0].value, '6.1');
  db.close();
});

test('неразобранное — AE 100, строка rejected; известный, но не поддержанный тип — AR 200, строка rejected', () => {
  const db = fresh();
  const junk = receiveMessage(db, 'это не HL7', { peer: '10.0.0.9' });
  assert.equal(junk.code, 'AE');
  // LIS_VENDOR_EXACT_V1 — незнакомое — вид руководства (длинный).
  assert.equal(linesOf(junk.reply)[1], 'MSA|AE||Segment sequence error|||100|');
  assert.equal(last(db).status, 'rejected');
  assert.equal(last(db).kind, 'result');
  assert.equal(last(db).resolved_at, null, 'мусор ждёт человека в лотке, как прежде');

  const adt = receiveMessage(db, 'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ADT^A01|43|P|2.3.1', { peer: '10.0.0.9' });
  assert.equal(adt.code, 'AR');
  assert.equal(linesOf(adt.reply)[1], 'MSA|AR|43|Unsupported message type|||200', 'отказ без повтора (BC-5300 — короткий вид)');
  assert.equal(last(db).status, 'rejected', 'сообщение по-прежнему хранится и лежит в лотке');
  assert.match(last(db).detail, /ADT\^A01/);
  db.close();
});

test('сорвалась запись пробы — AE 207 «Application internal error»: прибор пришлёт снова', () => {
  const db = fresh();
  db.exec("CREATE TRIGGER lab_results_locked BEFORE INSERT ON lab_results BEGIN SELECT RAISE(ABORT, 'locked'); END");
  const out = receiveMessage(db, ORU(), { peer: '10.0.0.9', deviceId: 1 });
  assert.equal(out.code, 'AE');
  assert.equal(linesOf(out.reply)[1], 'MSA|AE|42|Application internal error|||207', 'гематология — как прежде, только CR в конце');
  assert.equal(last(db).status, 'rejected');
  db.close();
});

// Вид по заголовку и разбор приёма обязаны совпадать: «проба» для заголовка, но
// «не ORU» для parseMessage дала бы AE 207 («сорвалась запись») вместо AE 100 и
// завела бы прибор по мусору (index.js: allowCreate — по виду).
test('вид «проба» у заголовка — ровно там, где parseMessage разбирает ORU^R01', () => {
  for (const t of ['ORU^R01', 'ORU^R01^ORU_R01', 'ORU^R01 ', ' ORU^R01', 'ORU ^R01', 'ORU', 'ORU^', '^R01', 'oru^r01']) {
    const raw = `MSH|^~\\&|BC-5300|Mindray|||20260910143943||${t}|42|P|2.3.1\rOBR|1||LAB-000001`;
    let parsed = true;
    try { parseMessage(raw); } catch { parsed = false; }
    assert.equal(readEnvelope(raw).kind === 'result', parsed, JSON.stringify(t));
  }
  const db = fresh();
  const out = receiveMessage(db, 'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01 |42|P|2.3.1\rOBR|1||LAB-000001', { peer: '10.0.0.9' });
  assert.equal(out.code, 'AR', 'разобранный заголовок неподдержанного типа — AR, а не «сорвалась запись»');
  assert.equal(last(db).status, 'rejected');
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R1, п. 7 ─────────────────────────────────
// MSH-16 = 1/2 — калибровка и контроль только у провода, который объявляет
// это соглашение (химия Mindray, Autobio по сети). У гематологии и прочих
// MSH-16 в виде сообщения не участвует: проба пациента не прячется в
// «служебные», где её никто не увидит.
test('R1 п. 7: гематология с MSH-16 = 2 — проба, а не контроль: идёт в приём и в бланк', () => {
  const db = fresh();
  const raw = seg(
    'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1||||2',
    'OBR|1||LAB-000001|00001^Automated Count^99MRC',
    'OBX|1|NM|WBC^^99MRC||6.1|10*9/L|||||F',
  );
  const out = receiveMessage(db, raw, { peer: '10.0.0.5', deviceId: 1 });
  assert.equal(out.kind, 'result');
  assert.equal(last(db).kind, 'result');
  assert.equal(last(db).resolved_at, null);
  assert.equal(results(db).find((r) => r.parameter === 'Лейкоциты').value, '6.1');
  const f = linesOf(out.reply)[0].split('|');
  assert.equal(f[15] || '', '2', 'эхо MSH-16 — как пришло: 0/1/2 руководства BS-200');
  db.close();
});

test('R1 п. 7: строка прибора BS-200 — MSH-16 = 2 по-прежнему контроль', () => {
  const db = fresh();
  db.prepare("UPDATE lab_devices SET profile = 'mindray-bs-200' WHERE id = 1").run();
  const out = receiveMessage(db, BS200_QC().replace('Mindray|BS-200E', 'X|Y'), { peer: '10.0.0.40', deviceId: 1 });
  assert.equal(out.kind, 'qc', 'провод профиля — mindray-chem');
  assert.equal(last(db).kind, 'qc');
  db.close();
});

// ── LIS_VENDOR_EXACT_V1 — вид ответа по проводу и профилю (D1, D9, D13) ─────
// Сообщения — раскладка производителя, значения синтетические
// (analyzer-research\notes\capture-kit\tests\run-tests.ps1: BS200_ORU, CL_ORU,
// A1000_TEST, A1000_SAMPLE; A1000 — вывод кодировщика прибора клиники,
// autobio-autolumo-a1000.settle.md, находка 1).
const segsCr = (...s) => s.join('\r') + '\r';
const BS200_ORU_T1 = segsCr('MSH|^~\\&|Mindray|BS-200|||20261005101500||ORU^R01|7|P|2.3.1||||0||ASCII|||', 'PID|1',
  'OBR|1|LAB-000001|12|Mindray^BS-200|N||20261005101200||||||||serum', 'OBX|1|NM|test1|Test 1|5.230000|g/l|3.900000-6.100000|N|||F|||20261005101200');
const CL_ORU = segsCr('MSH|^~\\&|||||20120508094822||ORU^R01|1|P|2.3.1||||0||ASCII|||', 'PID|1|TEST-0001|||||||||||||||||||||||||||',
  'OBR|1|LAB-000125|10|^|Y|20120405193926|20120405193914|20120405193914||||||20120405193914|serum|||||||||3|||||||||||||||||||||||',
  'OBX|1|NM|2|TBil|100| umol/L |-|N|||F||100|20120405194245||tester|0|');
const A1000_TEST = segsCr('MSH|^~\\&|||||20261005120000||ORU^R01|5|P|2.3.1|261005120000123', 'OBR|1|LAB-000123|7764|AutoLumo A1000',
  'NTE|||180323~~AFP~107~20271231~DQ70~1', 'OBX|10455|CE|107|107|41765^4.17~||||||F|||2026/10/05 12:00:00');
const A1000_SAMPLE = segsCr('MSH|^~\\&|||||20261005120000||ORU^R01|7|P|2.3.1|261005120000124', 'OBR|1|LAB-000123|7764|AutoLumo A1000',
  'OBX||CE|107||41765^4.17||||||F', 'OBX||CE|112||22000^1.23||||||F');

test('LIS_VENDOR_EXACT_V1 D1: химия Mindray (строка BS-200) — сорвалась запись: AR 206 «Application record locked» (HIM v5.0 с. 9, 25), а не AE 207', () => {
  const db = fresh();
  db.prepare("UPDATE lab_devices SET profile = 'mindray-bs-200' WHERE id = 1").run();
  // Номер теста подтверждён для ЭТОГО прибора и его модели (мигр. 233): иначе
  // приём до записи не дойдёт — строка ляжет в лоток «подтвердите заново».
  db.prepare(`UPDATE lab_panel_analytes SET device_code_confirmed_device_id = 1,
              device_code_confirmed_epoch = (SELECT code_epoch FROM lab_devices WHERE id = 1) WHERE panel_id = 5`).run();
  db.exec("CREATE TRIGGER lab_results_locked BEFORE INSERT ON lab_results BEGIN SELECT RAISE(ABORT, 'locked'); END");
  const out = receiveMessage(db, BS200_ORU_T1, { peer: '10.0.0.40', deviceId: 1 });
  assert.equal(out.code, 'AR');
  const [mshLine, msa] = linesOf(out.reply);
  assert.equal(mshLine.split('|').length, 21, 'вид руководства');
  assert.equal(msa, 'MSA|AR|7|Application record locked|||206|', 'пример руководства, с. 25: MSA|AR|1|Application record locked|||206|');
  assert.equal(last(db).status, 'rejected');
  assert.match(last(db).detail, /ошибка записи/);
  db.close();
});

test('LIS_VENDOR_EXACT_V1 D1: незнакомый прибор без профиля, MSH-3/4 пусты (BS-240, CL-900i) — вид руководства: 19 «|» после «^~\\&» (CL-900i SM pdf 603)', () => {
  const db = fresh();
  const out = receiveMessage(db, CL_ORU, { peer: '10.0.0.60' });
  assert.equal(out.code, 'AA');
  const [mshLine, msa] = linesOf(out.reply);
  assert.equal((mshLine.slice(mshLine.indexOf('^~\\&') + 4).match(/\|/g) || []).length, 19);
  assert.equal(msa, 'MSA|AA|1|Message accepted|||0|');
  db.close();
});

test('LIS_VENDOR_EXACT_V1 D9: A1000 (строка с профилем, MSH-3/4 пусты) — длинный вид; MSA-4 = OBX-1 по тесту, OBR-3 по пробе (settle, табл. c, R1/R5)', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile, transport, port) VALUES (2,'ИХЛА','autobio-autolumo-a1000','mllp',2575)").run();
  const byTest = receiveMessage(db, A1000_TEST, { peer: '10.0.0.41', deviceId: 2 });
  assert.equal(byTest.code, 'AA');
  const [mshLine, msa] = linesOf(byTest.reply);
  assert.equal(mshLine.split('|').length, 21);
  assert.equal(mshLine.split('|')[9], '5', 'MSH-10 эхом: декодер принимает только 5 или 7');
  assert.equal(msa, 'MSA|AA|5|Message accepted|10455||0|', 'результат станет «Accepted»');
  const bySample = receiveMessage(db, A1000_SAMPLE, { peer: '10.0.0.41', deviceId: 2 });
  assert.equal(linesOf(bySample.reply)[1], 'MSA|AA|7|Message accepted|7764||0|');
  db.close();
});

test('LIS_VENDOR_EXACT_V1 D1: переадресатор (MSH-4 = LabPC) — длинный вид и у строки гематологии: ответ читает переадресатор (deliver.js: /MSA\\|AA/)', () => {
  const db = fresh();
  const raw = seg('MSH|^~\\&|BC-5300|LabPC|||20261001101600||ORU^R01|5|P|2.3.1', 'OBR|1||LAB-000001|', 'OBX|1|NM|WBC^^99MRC|Лейкоциты|6.1|10*9/L|||||F');
  const out = receiveMessage(db, raw, { peer: '10.0.0.50', deviceId: 1 });
  const [mshLine, msa] = linesOf(out.reply);
  assert.equal(mshLine.split('|').length, 21);
  assert.equal(msa, 'MSA|AA|5|Message accepted|||0|');
  db.close();
});

test('LIS_VENDOR_EXACT_V1: replyStyle — короткий вид только у гематологии (провод или вид профиля); химия, ИХЛА, A1000, переадресатор и незнакомое — длинный', async () => {
  const { replyStyle } = await import('./receive.js');
  const P = (key) => getProfile(key);
  const cases = [
    [{ profile: P('mindray-bc-20') }, 'short'],
    [{ profile: P('mindray-bc-5300') }, 'short'],
    [{ profile: P('mindray-bc-780') }, 'short'],
    [{ profile: P('mindray-bc-2800') }, 'short'],
    [{ profile: P('mindray-bc-3000-plus') }, 'short'],
    [{ app: 'BC-5300', facility: 'Mindray' }, 'short'],
    [{ app: 'BC-780', facility: 'Mindray' }, 'short'],
    [{ profile: P('mindray-bs-200') }, 'long'],
    [{ profile: P('mindray-bs-240') }, 'long'],
    [{ profile: P('mindray-cl-900i') }, 'long'],
    [{ profile: P('autobio-autolumo-a1000') }, 'long'],
    [{ app: 'Mindray', facility: 'BS-200' }, 'long'],
    [{ app: 'A1000', facility: 'Autolumo' }, 'long'],
    [{}, 'long'],
    [{ profile: P('mindray-bc-5300'), app: 'BC-5300', facility: 'LabPC' }, 'long'],
    [{ profile: P('mindray-bc-5300'), app: 'Mindray', facility: 'BS-200' }, 'long'],
    [{ profile: P('mindray-bs-200'), app: 'BC-5300', facility: 'Mindray' }, 'short'],
  ];
  for (const [o, want] of cases) {
    assert.equal(replyStyle(o).layout, want, JSON.stringify({ ...o, profile: o.profile && o.profile.key }));
  }
  assert.equal(replyStyle({ profile: P('mindray-bs-200') }).wire, 'mindray-chem');
  assert.equal(replyStyle({ profile: P('autobio-autolumo-a1000') }).wire, 'autobio-hl7');
});
