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

const seg = (...s) => s.join('\r');
// Пустые поля в конце сегмента смысла не несут: руководство пишет «…|NF|».
const fieldsOf = (line) => { const f = line.split('|'); while (f.length && f[f.length - 1] === '') f.pop(); return f; };

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
  const [mshLine, msa] = out.reply.split('\r');
  const f = fieldsOf(mshLine);
  assert.deepEqual([f[4], f[5], f[8], f[9], f[15], f[17]], ['Mindray', 'BS-200E', 'ACK^R01', '1', '2', 'ASCII'], 'с. 27: ответ на QC несёт MSH-16 = 2');
  assert.equal(msa, 'MSA|AA|1|Message accepted|||0');

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
  assert.equal(fieldsOf(out.reply.split('\r')[0])[15], '1');
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
  const lines = out.reply.split('\r');
  // с. 28: «MSH|^~\&|||Manufacturer|Model|20070723170707||QCK^Q02|1|P|2.3.1||||||ASCII|||»
  const got = fieldsOf(lines[0]);
  got[6] = '<время>';
  assert.deepEqual(got, fieldsOf('MSH|^~\\&|EASYMED|CLINIC|Mindray|BS-200E|<время>||QCK^Q02|1|P|2.3.1||||||ASCII|||'));
  assert.deepEqual(lines.slice(1).map(fieldsOf), ['MSA|AA|1|Message accepted|||0|', 'ERR|0|', 'QAK|SR|NF|'].map(fieldsOf),
    '«If the sample of the bar code does not exist» — дословно с. 28');
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
  assert.equal(fieldsOf(out.reply.split('\r')[0])[8], 'QCK^Q02');
  assert.match(out.reply, /QAK\|SR\|NF/);
  assert.equal(last(db).kind, 'query');
  assert.match(last(db).detail, /отмен/);
  db.close();
});

test('QRY^Q01 Autobio → DSR^Q01: MSA AA, ERR|0, QAK|SR|NF, эхо QRD и QRF, без DSP', () => {
  const db = fresh();
  const out = receiveMessage(db, AUTOBIO_QRY, { peer: '10.0.0.41', deviceId: null });
  assert.equal(out.code, 'AA');
  const lines = out.reply.split('\r');
  assert.equal(fieldsOf(lines[0])[8], 'DSR^Q01');
  assert.equal(fieldsOf(lines[0])[9], '3');
  assert.equal(lines[1], 'MSA|AA|3|Message accepted|||0');
  assert.equal(lines[2], 'ERR|0');
  assert.equal(lines[3], 'QAK|SR|NF', '«нет данных» — по аналогии с QCK; проверить на приборе');
  assert.equal(lines[4], 'QRD|20261001101500|R|D|7|||RD|LAB-000123|OTH|||T');
  assert.equal(lines[5], 'QRF|A1000|20261001000000|20261001101500|||RCT|COR|ALL');
  assert.ok(!lines.some((l) => l.startsWith('DSP')), 'заказов Easy-Med не отдаёт');
  assert.equal(last(db).sample_id, 'LAB-000123');
  assert.equal(last(db).kind, 'query');
  assert.equal(results(db).length, 0);
  db.close();
});

test('ORM^O01 гематологии Mindray → ACK^O01 «принято»', () => {
  const db = fresh();
  const out = receiveMessage(db, 'MSH|^~\\&|BC-780|Mindray|||20261001090000||ORM^O01|9|P|2.3.1||||||UNICODE', { peer: '10.0.0.42' });
  assert.equal(out.code, 'AA');
  const [mshLine, msa] = out.reply.split('\r');
  assert.equal(fieldsOf(mshLine)[8], 'ACK^O01');
  assert.equal(msa, 'MSA|AA|9|Message accepted|||0');
  assert.equal(last(db).kind, 'query');
  assert.ok(last(db).resolved_at);
  db.close();
});

test('проба пациента идёт в приём, как прежде; ответ — ACK^R01 AA', () => {
  const db = fresh();
  const out = receiveMessage(db, ORU(), { peer: '10.0.0.9', deviceId: 1 });
  assert.equal(out.code, 'AA');
  assert.equal(out.kind, 'result');
  assert.equal(fieldsOf(out.reply.split('\r')[0])[8], 'ACK^R01');
  assert.equal(out.reply.split('\r')[1], 'MSA|AA|42|Message accepted|||0');
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
  assert.equal(junk.reply.split('\r')[1], 'MSA|AE||Segment sequence error|||100');
  assert.equal(last(db).status, 'rejected');
  assert.equal(last(db).kind, 'result');
  assert.equal(last(db).resolved_at, null, 'мусор ждёт человека в лотке, как прежде');

  const adt = receiveMessage(db, 'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ADT^A01|43|P|2.3.1', { peer: '10.0.0.9' });
  assert.equal(adt.code, 'AR');
  assert.equal(adt.reply.split('\r')[1], 'MSA|AR|43|Unsupported message type|||200', 'отказ без повтора');
  assert.equal(last(db).status, 'rejected', 'сообщение по-прежнему хранится и лежит в лотке');
  assert.match(last(db).detail, /ADT\^A01/);
  db.close();
});

test('сорвалась запись пробы — AE 207 «Application internal error»: прибор пришлёт снова', () => {
  const db = fresh();
  db.exec("CREATE TRIGGER lab_results_locked BEFORE INSERT ON lab_results BEGIN SELECT RAISE(ABORT, 'locked'); END");
  const out = receiveMessage(db, ORU(), { peer: '10.0.0.9', deviceId: 1 });
  assert.equal(out.code, 'AE');
  assert.equal(out.reply.split('\r')[1], 'MSA|AE|42|Application internal error|||207');
  assert.equal(last(db).status, 'rejected');
  db.close();
});
