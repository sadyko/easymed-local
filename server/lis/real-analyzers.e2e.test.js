// real-analyzers.e2e.test.js — LIS_REAL_ANALYZERS_V1, E10: сквозная проверка
// трёх настоящих приборов клиники (docs/specs/2026-10-01-lis-real-analyzers-design.md,
// «Сквозная проверка на копии базы», п. 1).
//
// Всё настоящее, кроме приборов: база — файл во временной папке, собранный
// migrate() (не data/), слушатели — startLisListeners на свободном LIS_PORT,
// клиент к прибору-серверу — тот же startLisListeners (lab_devices.dial = 1).
// Приборы — сырой TCP с кадрами MLLP. Каждый «прибор» говорит со своего адреса
// петли (127.0.0.2, .3, …): в клинике у каждого свой IP, и различение приборов
// (адрес + MSH-3, LIS_DISCOVERY_FIX_V1) проверяется таким, как в жизни.
//
// Фикстуры — те же, что в разделе «Тесты» спецификации: BS-200 — руководство
// «BS-200 Host Interface Manual v1.2», с. 24–28 (штрихкод — наша этикетка);
// Autobio HL7 — собрано по драйверу LiveMachine AutoLumoHL7.cs (не документ);
// переадресатор — договор forwarder/hl7-oru.js; BC-780 — по записи BC-3600
// (geulis) и BC-5380 (соседние модели).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { tmpDir, closeOnExit } from '../test-helpers/tmpdir.js';
import { startLisListeners, stopLisListeners, listenerStatus, selfPorts } from './index.js';
import { VT, FS } from './mllp.js';
import { SERIES_PENDING_PREFIX } from './inbox.js';
import { lisRecent, lisServiceCounts, lisDeviceDelete, lisListeners } from '../services/rpc/lis.js';
import { lisMessageAttach } from '../services/rpc/lis.js';   // LIS_REAL_ANALYZERS_V1 — ревью R3, п. 3

const LAB = { role: 'lab' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, what = 'условие') {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(what + ' не наступило за ' + ms + ' мс');
    await sleep(10);
  }
}
const frame = (s) => Buffer.concat([Buffer.from([VT]), Buffer.from(s, 'utf8'), Buffer.from([FS, 0x0d])]);
/** Поле n сегмента seg ответа (MSH-1 — разделитель, как в HL7: MSH-9 = индекс 8 после split). */
function fieldOf(text, seg, n) {
  const line = String(text).split('\r').find((l) => l.startsWith(seg + '|'));
  if (!line) return undefined;
  const f = line.split('|');
  return seg === 'MSH' ? f[n - 1] : f[n];
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '0.0.0.0', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

/** Прибор, который звонит в Easy-Med сам: одно соединение, кадр за кадром, ответ на каждый. */
async function analyzer(port, localAddress) {
  const sock = net.createConnection({ host: '127.0.0.1', port, localAddress });
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  sock.on('error', () => {});
  let buf = Buffer.alloc(0);
  const replies = [];
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const s = buf.indexOf(VT);
      const e = buf.indexOf(FS, s + 1);
      if (s === -1 || e === -1) break;
      replies.push(buf.slice(s + 1, e).toString('utf8'));
      buf = buf.slice(e + 1);
    }
  });
  return {
    async send(text) {
      const n = replies.length;
      sock.write(frame(text));
      await until(() => replies.length > n, 10000, 'ответ Easy-Med');
      return replies[n];
    },
    close() { sock.destroy(); },
  };
}

/**
 * Свежая база-файл во временной папке (migrate) и свободный LIS_PORT; fn(db,
 * lisPort). Слушатели, клиенты и база закрываются всегда; папку убирает
 * tmpDir при выходе процесса (TEST_TMPDIR_V1).
 */
async function withClinic(fn) {
  const dir = tmpDir('em-lra-e2e-');
  const db = openDb(path.join(dir, 'easymed.db'));
  closeOnExit(db);
  migrate(db);
  const lisPort = await freePort();
  const prev = process.env.LIS_PORT;
  process.env.LIS_PORT = String(lisPort);
  try {
    seedClinic(db);
    await fn(db, lisPort);
  } finally {
    await stopLisListeners();
    if (prev === undefined) delete process.env.LIS_PORT; else process.env.LIS_PORT = prev;
    db.close();
  }
}

/**
 * Клиника: три пациента, визиты сегодня, услуги «Биохимия», «Витамин B12»,
 * «Общий анализ крови». Заказы, в которые результату легко было бы лечь не
 * туда: № 1 и № 2 — открытая свежая биохимия (номер теста QC BS-200 и место в
 * штативе — «1» и «2»); № 124 — открытая биохимия восьмидневной давности.
 */
function seedClinic(db) {
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван'), (4,'Каримова Азиза'), (5,'Петров Пётр')").run();
  const now = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
  const old = "strftime('%Y-%m-%dT%H:%M:%SZ','now','-8 days')";
  db.prepare(`INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,${now},'scheduled'), (56,4,${now},'scheduled'), (57,5,${old},'scheduled')`).run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'Биохимия',1), (10,'Витамин B12',1), (11,'Общий анализ крови',1)").run();
  const vs = db.prepare('INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (?, ?, ?, ?, ' + now + ')');
  vs.run(1, 56, 9, 'in_progress');
  vs.run(2, 56, 9, 'in_progress');
  vs.run(123, 55, 9, 'queued');      // лаборатория не нажала «Забор пробы» — заказ открыт
  vs.run(201, 56, 10, 'queued');
  vs.run(202, 55, 10, 'queued');
  vs.run(301, 55, 11, 'queued');
  vs.run(302, 56, 11, 'queued');
  vs.run(303, 55, 11, 'queued');
  db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (124, 57, 9, 'queued', ${old})`).run();
}

/** Панель услуги, привязанная к прибору, с подтверждёнными (D4) кодами прибора. */
function bindPanel(db, { id, serviceId, deviceId, name, lines }) {
  db.prepare('INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (?, ?, ?, ?)').run(id, name, serviceId, deviceId);
  lines.forEach(([code, label, unit, deviceCode], i) => db.prepare(`INSERT INTO lab_panel_analytes
      (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed) VALUES (?, ?, ?, ?, ?, ?, 1)`)
    .run(id, code, label, unit, i + 1, deviceCode));
}

const blank = (db, vsId) => Object.fromEntries(db.prepare('SELECT parameter, value FROM lab_results WHERE visit_service_id = ? ORDER BY id').all(vsId).map((r) => [r.parameter, r.value]));
const tray = (db) => db.prepare("SELECT * FROM lab_device_messages WHERE resolved_at IS NULL AND status <> 'applied' ORDER BY id").all();
const last = (db) => db.prepare('SELECT * FROM lab_device_messages ORDER BY id DESC LIMIT 1').get();
const order = (db, id) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;
/** Инвариант 1 — приём доводит заказ до resulted и ни шагом дальше: ничего не выдано. */
function notReleased(db, vsId) {
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = ? AND (verified_at IS NOT NULL OR verified_by IS NOT NULL)').get(vsId).c, 0, 'автовыдачи нет: ' + vsId);
  assert.notEqual(order(db, vsId), 'completed', 'заказ не выдан: ' + vsId);
}

// ── Mindray BS-200 ─────────────────────────────────────────────────────────
// Руководство, с. 24–25: ORU^R01 — по одному тесту; «Manufacturer|Model» —
// «Mindray|BS-200E»; в OBR-2 — штрихкод (наша этикетка), в OBR-3 — место в штативе.
let bsId = 0;
const BS_ORU = (barcode, test, name, value, { rack = '2' } = {}) => [
  `MSH|^~\\&|Mindray|BS-200E|||20261001101500||ORU^R01|${++bsId}|P|2.3.1||||0||ASCII|||`,
  'PID|1|854||12|Tommy||19830719145307|F|A||||||||||||||||||||||',
  `OBR|1|${barcode}|${rack}|Mindray^BS-200E|Y||||||||||serum|||||||||||||||||||||||||||||||||`,
  `OBX|1|NM|${test}|${name}|${value}|g/ml|-||||F|||||||`,
].join('\r');
// С. 26–27: контроль качества (MSH-16 = 2) — в OBR-2 НОМЕР ТЕСТА «1»; калибровка — MSH-16 = 1.
const BS_SERVICE = (ackType) => [
  `MSH|^~\\&|Mindray|BS-200E|||20070720120202||ORU^R01|${++bsId}|P|2.3.1||||${ackType}||ASCII|||`,
  'OBR|1|1|test1|Mindray^BS-200E||20070720120143|||||||QUAL1|1111|20080720000000||H|5.000000|2.000000|0.11029|g/ml|||||||||||||||||||||||||||',
  'OBX|1|NM|2|test2|5.200000|g/ml|-||||F|||||||',
].join('\r');
// С. 27: запрос рабочего списка по пробирке (QRD-8).
const BS_QRY = (barcode) => [
  `MSH|^~\\&|Mindray|BS-200E|||20070723170707||QRY^Q02|${++bsId}|P|2.3.1||||||ASCII|||`,
  `QRD|20070723170707|R|D|1|||RD|${barcode}|OTH|||T|`,
  'QRF|BS-200E|20070723170749|20070723170749|||RCT|COR|ALL||',
].join('\r');

test('BS-200: запрос — «заказов нет»; контроль и калибровка — мимо бланков и лотка; три сообщения по тесту — серия, бланк полон, не выдан; место в штативе и голый номер старого заказа — отказ', async () => {
  await withClinic(async (db, lisPort) => {
    await startLisListeners(db, { log: () => {} });
    const bs = await analyzer(lisPort, '127.0.0.2');
    try {
      // 1. Запрос рабочего списка (с. 27) → QCK^Q02 «заказов нет» (с. 28). Прибор найден с первого запроса.
      bsId = 0;
      const qck = await bs.send(BS_QRY('LAB-000123'));
      assert.equal(fieldOf(qck, 'MSH', 9), 'QCK^Q02');
      assert.match(qck, /\rMSA\|AA\|1\|Message accepted\|\|\|0/);
      assert.match(qck, /\rERR\|0/);
      assert.match(qck, /\rQAK\|SR\|NF/);
      const dev = db.prepare("SELECT * FROM lab_devices WHERE host = '127.0.0.2'").get();
      assert.ok(dev, 'прибор найден по запросу');
      assert.deepEqual([dev.profile, dev.sending_app, dev.sending_facility, dev.added], ['mindray-bs-200', 'Mindray', 'BS-200E', 0]);
      // Лаборатория: «Добавить», панель биохимии — к прибору, номера тестов (ItemID.ini) подтверждены.
      db.prepare('UPDATE lab_devices SET added = 1, model_confirmed = 1 WHERE id = ?').run(dev.id);
      bindPanel(db, { id: 5, serviceId: 9, deviceId: dev.id, name: 'Биохимия', lines: [
        ['GLU', 'Глюкоза', 'ммоль/л', '2'], ['UREA', 'Мочевина', 'ммоль/л', '3'], ['CALC', 'Расчётный', '', '102']] });

      // 2. Контроль качества и калибровка: ACK^R01 AA с MSH-16 эхом; не в бланк (заказ № 1 —
      //    открытая свежая биохимия, номер теста «1» с ним совпадает) и не в лоток.
      for (const [ackType, kind] of [['2', 'qc'], ['1', 'calibration']]) {
        const ack = await bs.send(BS_SERVICE(ackType));
        assert.equal(fieldOf(ack, 'MSH', 9), 'ACK^R01');
        assert.equal(fieldOf(ack, 'MSH', 16), ackType, 'MSH-16 эхом (с. 27)');
        assert.match(ack, /\rMSA\|AA\|/);
        const m = last(db);
        assert.deepEqual([m.kind, m.status, m.visit_service_id, !!m.resolved_at], [kind, 'unmatched', null, true]);
      }
      assert.deepEqual(blank(db, 1), {}, 'заказ № 1 не тронут');
      assert.deepEqual(tray(db), [], 'служебные — не в «Необработанных»');

      // 3. Серия: три сообщения по одному тесту (с. 24–25). Пока не пришли все
      //    строки бланка — «ждём» в лотке; третье — серия чистая, все applied.
      const sends = [['2', 'test2', '5.000000'], ['3', 'test3', '10.000000'], ['102', 'calctest1', '15.000000']];
      for (let i = 0; i < sends.length; i++) {
        const ack = await bs.send(BS_ORU('LAB-000123', ...sends[i]));
        assert.equal(fieldOf(ack, 'MSH', 9), 'ACK^R01');
        assert.match(ack, /\rMSA\|AA\|\d+\|Message accepted\|\|\|0/);
        if (i < 2) {
          assert.equal(tray(db).length, i + 1, 'строки серии ждут остальные');
          assert.ok(tray(db).every((m) => m.detail.startsWith(SERIES_PENDING_PREFIX)), tray(db).map((m) => m.detail).join(' | '));
        }
      }
      assert.deepEqual(tray(db), [], 'серия дошла — «Необработанные» пусты (правило лотка владельца по серии)');
      const series = db.prepare("SELECT status, detail FROM lab_device_messages WHERE sample_id = 'LAB-000123' AND kind = 'result' ORDER BY id").all();
      assert.deepEqual(series.map((m) => m.status), ['applied', 'applied', 'applied']);
      assert.equal(series[2].detail, 'серия из 3 сообщений принята');
      assert.deepEqual(blank(db, 123), { 'Глюкоза': '5', 'Мочевина': '10', 'Расчётный': '15' }, '«5.000000» → «5»: нули срезаны, не округлено');
      assert.equal(order(db, 123), 'resulted');
      notReleased(db, 123);

      // 4. Место в штативе: OBR-2 пуст, OBR-3 = «2» — BS-200 OBR-3 не читается никогда (с. 24).
      await bs.send(BS_ORU('', '2', 'test2', '6.100000', { rack: '2' }));
      let m = last(db);
      assert.deepEqual([m.status, m.visit_service_id], ['unmatched', null]);
      assert.deepEqual(blank(db, 2), {}, 'заказ № 2 (чужой пациент) не тронут');

      // 5. Голый номер старого открытого заказа (8 дней) — отказ с причиной, без привязки.
      await bs.send(BS_ORU('124', '2', 'test2', '7.000000'));
      m = last(db);
      assert.deepEqual([m.status, m.visit_service_id], ['unmatched', null]);
      assert.match(m.detail, /без префикса LAB- указывает на заказ № 124/);
      assert.match(m.detail, /старше 7 дней/);
      assert.deepEqual(blank(db, 124), {}, 'бланк старого заказа не тронут');
      //    Наша этикетка к тому же заказу — принята: правило только для голых цифр.
      await bs.send(BS_ORU('LAB-000124', '2', 'test2', '7.000000'));
      assert.deepEqual(blank(db, 124), { 'Глюкоза': '7' });
      assert.ok(last(db).detail.startsWith(SERIES_PENDING_PREFIX), 'ждёт остальные строки бланка');

      // 6. Экран: служебные за сегодня — у прибора; живая лента — только пробы.
      assert.deepEqual(lisServiceCounts(db, {}, LAB), [{ device_id: dev.id, qc: 1, calibration: 1, query: 1 }]);
      const service = new Set(db.prepare("SELECT id FROM lab_device_messages WHERE kind <> 'result'").all().map((r) => r.id));
      assert.equal(service.size, 3);
      assert.ok(lisRecent(db, { limit: 50 }, LAB).every((r) => !service.has(r.id)), 'контроль, калибровка и запрос в ленту не попали');
      assert.ok(db.prepare('SELECT last_seen_at FROM lab_devices WHERE id = ?').get(dev.id).last_seen_at, 'прибор на связи');

      // 7. Ревью R2 — находка названа «Mindray BS-200E» (модель — в MSH-4), а не
      //    «Mindray»; различение — по-прежнему адрес и MSH-3.
      assert.equal(dev.name, 'Mindray BS-200E');
      // 8. Ревью R2, п. 1 — второй BS-200: номер теста свой у каждого прибора
      //    (ItemID.ini), «2» у него — креатинин. Панель биохимии привязана к
      //    первому — в её бланк проба второго не идёт: лоток с причиной.
      const bs2 = await analyzer(lisPort, '127.0.0.6');
      try {
        const ack = await bs2.send(BS_ORU('LAB-000002', '2', 'CREA', '88.000000'));
        assert.match(ack, /\rMSA\|AA\|/);
        const dev2 = db.prepare("SELECT * FROM lab_devices WHERE host = '127.0.0.6'").get();
        assert.deepEqual([dev2.profile, dev2.name], ['mindray-bs-200', 'Mindray BS-200E (127.0.0.6)']);
        m = last(db);
        assert.deepEqual([m.status, m.device_id, m.visit_service_id], ['unmatched', dev2.id, 2]);
        assert.match(m.detail, /привязана к другому анализатору той же модели/);
        assert.deepEqual(blank(db, 2), {}, 'креатинин второго прибора не лёг в «Глюкозу» заказа № 2');
      } finally { bs2.close(); }
    } finally { bs.close(); }
  });
});

// ── Autobio AutoLumo A1000 ─────────────────────────────────────────────────
// По сети — HL7, собрано по драйверу AutoLumoHL7.cs (строки 129–163): номер —
// OBR-2, код позиции — OBX-4, концентрация — компонент 2 поля OBX-5 (компонент
// 1 — RLU). Через переадресатор с COM — договор forwarder/hl7-oru.js: MSH-4 =
// LabPC, номер — OBR-3, код — OBX-3 («206^^AUTOBIO»), подпись — OBX-4.
const A_QRY = ['MSH|^~\\&|A1000|Autolumo|||20261001101500||QRY^Q01|3|P|2.3.1',
  'QRD|20261001101500|R|D|7|||RD|LAB-000201|OTH|||T', 'QRF|A1000|20261001000000|20261001101500|||RCT|COR|ALL'].join('\r');
const A_ORU = (label) => ['MSH|^~\\&|A1000|Autolumo|||20261001101500||ORU^R01|4|P|2.3.1||||0||ASCII|||',
  `OBR|1|${label}|||`, 'OBX|1|NM|1^Vitamin B12|206|5981666^390.946|pg/mL||||||F'].join('\r');
const FWD_ORU = (label) => ['MSH|^~\\&|AutoLumo A1000|LabPC|||20261001101600||ORU^R01|5|P|2.3.1',
  `OBR|1||${label}|`, 'OBX|1|NM|206^^AUTOBIO|Vitamin B12|390.946|pg/mL|||||F'].join('\r');

test('A1000: по сети (HL7) и через переадресатор с COM — одна панель, код позиции 206, в бланке концентрация, не RLU; запрос QRY^Q01 — DSR^Q01 «заказов нет»', async () => {
  await withClinic(async (db, lisPort) => {
    await startLisListeners(db, { log: () => {} });
    const net1 = await analyzer(lisPort, '127.0.0.3');
    const fwd = await analyzer(lisPort, '127.0.0.4');
    try {
      const dsr = await net1.send(A_QRY);
      assert.equal(fieldOf(dsr, 'MSH', 9), 'DSR^Q01');
      assert.match(dsr, /\rMSA\|AA\|3/);
      assert.match(dsr, /\rQAK\|SR\|NF/);
      assert.ok(!/\rDSP\|/.test(dsr), 'заказов Easy-Med не отдаёт');
      const dev = db.prepare("SELECT * FROM lab_devices WHERE host = '127.0.0.3'").get();
      assert.equal(dev.profile, 'autobio-autolumo-a1000', 'модель — по MSH-3 «A1000»');
      db.prepare('UPDATE lab_devices SET added = 1 WHERE id = ?').run(dev.id);
      bindPanel(db, { id: 6, serviceId: 10, deviceId: dev.id, name: 'Витамин B12', lines: [['B12', 'Витамин B12', 'пг/мл', '206']] });

      const ack = await net1.send(A_ORU('LAB-000201'));
      assert.equal(fieldOf(ack, 'MSH', 9), 'ACK^R01');
      assert.match(ack, /\rMSA\|AA\|4\|/);
      assert.equal(last(db).status, 'applied');
      assert.deepEqual(blank(db, 201), { 'Витамин B12': '390.946' }, 'компонент 2 — концентрация, а не «5981666^390.946»');
      assert.equal(order(db, 201), 'resulted');
      notReleased(db, 201);

      const ack2 = await fwd.send(FWD_ORU('LAB-000202'));
      assert.match(ack2, /\rMSA\|AA\|5\|/);
      const fdev = db.prepare("SELECT * FROM lab_devices WHERE host = '127.0.0.4'").get();
      assert.deepEqual([fdev.profile, fdev.sending_facility], ['autobio-autolumo-a1000', 'LabPC'], 'переадресатор — отдельная строка той же модели');
      assert.equal(last(db).status, 'applied', 'та же модель — та же панель (правило «та же модель»)');
      assert.deepEqual(blank(db, 202), { 'Витамин B12': '390.946' }, 'провод переадресателя: код из OBX-3');
      notReleased(db, 202);
      assert.deepEqual(tray(db), []);
    } finally { net1.close(); fwd.close(); }
  });
});

// ── Mindray BC-780 ─────────────────────────────────────────────────────────
// Публичного документа нет — по соседним моделям: HL7 v2.3.1, OBR-3,
// «LOINC^ИМЯ^LN», MSH-18 = UNICODE. Сопоставляется по имени (компонент 2).
let bcId = 10;
const BC_ORU = (label) => [`MSH|^~\\&|BC-780|Mindray|||20261001090000||ORU^R01|${++bcId}|P|2.3.1||||||UNICODE`,
  `OBR|1||${label}|00001^Automated Count^99MRC|||20261001090000`,
  'OBX|1|NM|6690-2^WBC^LN||7.25|10*9/L|4.0-10.0|N|||F',
  'OBX|2|NM|718-7^HGB^LN||135|g/L|120-160|N|||F'].join('\r');
const OAK = (db, deviceId) => bindPanel(db, { id: 7, serviceId: 11, deviceId, name: 'ОАК', lines: [
  ['WBC', 'Лейкоциты', '10^9/л', 'WBC'], ['HGB', 'Гемоглобин', 'г/л', 'HGB']] });

test('BC-780, прибор звонит сам на порт LIS: «Добавить по адресу» — строка берёт прибор, проба ложится по имени из «6690-2^WBC^LN», ответ ACK^R01 с эхом UNICODE', async () => {
  await withClinic(async (db, lisPort) => {
    db.prepare("INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, added, dial) VALUES (8, 'Гематология', 'mindray-bc-780', 'mllp', '127.0.0.5', ?, 1, 1, 0)").run(lisPort);
    OAK(db, 8);
    await startLisListeners(db, { log: () => {} });
    assert.ok(listenerStatus().listening.includes(lisPort));
    const bc = await analyzer(lisPort, '127.0.0.5');
    try {
      const ack = await bc.send(BC_ORU('LAB-000301'));
      assert.equal(fieldOf(ack, 'MSH', 9), 'ACK^R01');
      assert.equal(fieldOf(ack, 'MSH', 18), 'UNICODE', 'MSH-18 эхом');
      assert.match(ack, /\rMSA\|AA\|\d+\|Message accepted/);
      assert.equal(last(db).status, 'applied');
      assert.equal(last(db).device_id, 8, 'строка, заведённая человеком на этот адрес');
      assert.deepEqual(blank(db, 301), { 'Лейкоциты': '7.25', 'Гемоглобин': '135' });
      notReleased(db, 301);
      const dev = db.prepare('SELECT * FROM lab_devices WHERE id = 8').get();
      assert.deepEqual([dev.sending_app, dev.sending_facility], ['BC-780', 'Mindray']);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_devices').get().c, 1, 'находок нет');
    } finally { bc.close(); }
  });
});

/**
 * Поддельный BC-780 — прибор-СЕРВЕР: слушает 127.0.0.1, шлёт сигнал 0x02
 * каждые 100 мс (у BC-3600 — раз в 3 с, geulis), принимает ответы Easy-Med.
 * Порт берётся заново, если совпал с портом самого Easy-Med.
 */
async function fakeServerAnalyzer() {
  for (;;) {
    const conns = [];
    const acks = [];
    const server = net.createServer((sock) => {
      conns.push(sock);
      sock.on('error', () => {});
      const beat = setInterval(() => { if (!sock.destroyed) sock.write(Buffer.from([0x02])); }, 100);
      sock.on('close', () => clearInterval(beat));
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const s = buf.indexOf(VT);
          const e = buf.indexOf(FS, s + 1);
          if (s === -1 || e === -1) break;
          acks.push(buf.slice(s + 1, e).toString('utf8'));
          buf = buf.slice(e + 1);
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    if (selfPorts().includes(port)) { await new Promise((r) => server.close(r)); continue; }
    return {
      port, conns, acks,
      live: () => conns.filter((c) => !c.destroyed && !c.readableEnded),
      async close() { for (const c of conns) c.destroy(); await new Promise((r) => server.close(() => r())); },
    };
  }
}

test('BC-780, прибор ждёт звонка (dial): Easy-Med подключается, сигнал 0x02 не мешает, проба — ACK^R01, обрыв — переподключение, удаление прибора рвёт соединение', async () => {
  await withClinic(async (db, lisPort) => {
    const fake = await fakeServerAnalyzer();
    try {
      db.prepare("INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, added, dial) VALUES (7, 'BC-780', 'mindray-bc-780', 'mllp', '127.0.0.1', ?, 1, 1, 1)").run(fake.port);
      OAK(db, 7);
      await startLisListeners(db, { log: () => {} });
      const st = lisListeners(db, {}, LAB);
      assert.ok(st.listening.includes(lisPort) && !st.listening.includes(fake.port), 'порт прибора Easy-Med не слушает');
      const dialing = () => lisListeners(db, {}, LAB).dialing.find((d) => d.device_id === 7);
      await until(() => dialing() && dialing().state === 'connected', 5000, 'подключение');
      await until(() => dialing().last_rx_at, 3000, 'сигнал прибора');

      // Проба по соединению, которое держит Easy-Med.
      const sample = BC_ORU('LAB-000302');
      fake.live()[0].write(frame(sample));
      await until(() => fake.acks.length === 1, 5000, 'ответ');
      assert.equal(fieldOf(fake.acks[0], 'MSH', 9), 'ACK^R01');
      assert.match(fake.acks[0], /\rMSA\|AA\|\d+\|Message accepted/);
      const m = last(db);
      assert.deepEqual([m.device_id, m.status, m.peer], [7, 'applied', '127.0.0.1']);
      assert.ok(!m.raw.includes('\x02'), 'сигнал вне кадра в сообщение не попал');
      assert.equal(m.raw, sample, 'сохранено целиком (инвариант 2)');
      assert.deepEqual(blank(db, 302), { 'Лейкоциты': '7.25', 'Гемоглобин': '135' });
      notReleased(db, 302);
      assert.deepEqual([db.prepare('SELECT sending_app FROM lab_devices WHERE id = 7').get().sending_app], ['BC-780']);

      // Обрыв со стороны прибора — Easy-Med ждёт и подключается снова.
      fake.live()[0].destroy();
      await until(() => dialing().state === 'waiting' || fake.conns.length === 2, 3000, 'обрыв замечен');
      await until(() => fake.live().length === 1 && fake.conns.length === 2, 8000, 'переподключение');
      await until(() => dialing().state === 'connected', 3000, 'снова connected');
      fake.live()[0].write(frame(BC_ORU('LAB-000303')));
      await until(() => fake.acks.length === 2, 5000, 'ответ после переподключения');
      assert.deepEqual(blank(db, 303), { 'Лейкоциты': '7.25', 'Гемоглобин': '135' });

      // Удаление прибора: панель отвязывают (иначе отказ device_in_use), прибор
      // удаляют — соединение рвётся сразу, и больше Easy-Med ему не звонит.
      db.prepare('UPDATE lab_panels SET device_id = NULL WHERE id = 7').run();
      const t = Date.now();
      assert.equal((await lisDeviceDelete(db, { id: 7 }, LAB)).ok, true);
      assert.ok(Date.now() - t < 2000, 'удаление не ждёт прибора');
      await until(() => fake.live().length === 0, 3000, 'соединение порвано');
      await sleep(2600);
      assert.equal(fake.conns.length, 2, 'удалённому прибору не звонят');
      assert.equal(dialing(), undefined);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_device_messages WHERE device_id IS NULL').get().c, 2, 'сообщения остались целиком, отвязаны');
    } finally { await fake.close(); }
  });
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R3, п. 3: BS-200 сменил адрес (DHCP) ─────
// Клиника с одним BS-200: компьютер прибора получил новый адрес. Easy-Med
// видит новый прибор (новая строка — адрес другой), панель биохимии привязана
// к старой строке, а у BS-200 номер теста свой у каждого прибора — пробы идут в
// «Необработанные» и говорят, что делать: в «Панелях» выбрать для панели новую
// строку и подтвердить номера тестов заново (смена прибора панели их снимает —
// триггер мигр. 233), потом «Привязать» ждущие строки.
test('BS-200 сменил адрес: лоток с понятной причиной → панель на новую строку → номера подтверждены заново → «Привязать» → принято', async () => {
  await withClinic(async (db, lisPort) => {
    await startLisListeners(db, { log: () => {} });
    const before = await analyzer(lisPort, '127.0.0.2');
    let oldDev;
    try {
      bsId = 100;
      await before.send(BS_QRY('LAB-000001'));
      oldDev = db.prepare("SELECT * FROM lab_devices WHERE host = '127.0.0.2'").get();
      db.prepare('UPDATE lab_devices SET added = 1 WHERE id = ?').run(oldDev.id);
      bindPanel(db, { id: 5, serviceId: 9, deviceId: oldDev.id, name: 'Биохимия', lines: [
        ['GLU', 'Глюкоза', 'ммоль/л', '2'], ['UREA', 'Мочевина', 'ммоль/л', '3'], ['CALC', 'Расчётный', '', '102']] });
    } finally { before.close(); }

    // Новый адрес.
    const after = await analyzer(lisPort, '127.0.0.7');
    try {
      for (const t of [['2', 'test2', '5.000000'], ['3', 'test3', '10.000000'], ['102', 'calctest1', '15.000000']]) {
        assert.match(await after.send(BS_ORU('LAB-000001', ...t)), /\rMSA\|AA\|/);
      }
    } finally { after.close(); }
    const newDev = db.prepare("SELECT * FROM lab_devices WHERE host = '127.0.0.7'").get();
    assert.ok(newDev && newDev.id !== oldDev.id, 'новый адрес — новая строка прибора');
    assert.equal(newDev.profile, 'mindray-bs-200');
    const waiting = tray(db);
    assert.equal(waiting.length, 3, 'все три пробы — в «Необработанных»');
    for (const m of waiting) {
      assert.equal(m.status, 'unmatched');
      assert.match(m.detail, /если это тот же анализатор с новым адресом — в «Лаборатория → Панели» выберите для панели этот прибор и заново подтвердите номера тестов, потом «Привязать»/);
    }
    assert.deepEqual(blank(db, 1), {});

    // Лаборатория: панель — на новую строку; подтверждения сняты базой.
    db.prepare('UPDATE lab_panels SET device_id = ? WHERE id = 5').run(newDev.id);
    assert.deepEqual(db.prepare('SELECT device_code_confirmed AS c FROM lab_panel_analytes WHERE panel_id = 5').all().map((r) => r.c), [0, 0, 0]);
    // Номера тестов сверены с программой прибора — подтверждены заново.
    db.prepare('UPDATE lab_panel_analytes SET device_code_confirmed = 1 WHERE panel_id = 5').run();
    for (const m of waiting) lisMessageAttach(db, { id: m.id, visit_service_id: 1 }, LAB);
    assert.deepEqual(blank(db, 1), { 'Глюкоза': '5', 'Мочевина': '10', 'Расчётный': '15' });
    assert.deepEqual(tray(db), [], '«Необработанные» пусты');
    assert.equal(last(db).status, 'applied');
    assert.match(last(db).detail, /серия из 3 сообщений принята/);
    notReleased(db, 1);
  });
});
