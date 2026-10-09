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

/**
 * Панель услуги, привязанная к прибору, с подтверждёнными (D4) кодами прибора —
 * подтверждёнными для этого прибора (ревью R5, п. 2: так их пишет экран).
 */
function bindPanel(db, { id, serviceId, deviceId, name, lines }) {
  db.prepare('INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (?, ?, ?, ?)').run(id, name, serviceId, deviceId);
  lines.forEach(([code, label, unit, deviceCode], i) => db.prepare(`INSERT INTO lab_panel_analytes
      (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed, device_code_confirmed_device_id, device_code_confirmed_epoch)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, (SELECT code_epoch FROM lab_devices WHERE id = ?))`)
    .run(id, code, label, unit, i + 1, deviceCode, deviceId, deviceId));   // и эпоха кодов прибора, которую видел экран (ревью R6, п. 1)
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
// LIS_VENDOR_EXACT_V1 — по сети HL7 ровно так, как пишет кодировщик программы
// клиники AutoLumo1000.exe 1.0.7 (запуск её DLL на синтетических данных;
// analyzer-research: лист A1000, §3; settle, находка 1): MSH-3/4 пусты
// (параметры базы, на экране их нет), MSH-10 = 5 — код команды «по тесту»,
// OBR-2 — номер пробирки, OBR-3 — внутренний номер, NTE перед OBX (имя
// реагента, флаги прибора), OBX-1 — внутренний номер заявки, OBX-2 всегда CE,
// OBX-3 = OBX-4 = код теста, OBX-5 = RLU^концентрация~, OBX-6/7/8 пусты.
// Прежняя фикстура (по драйверу A2000 Plus: NM, единица, «A1000|Autolumo»)
// пряталась от того, что A1000 значения писались текстом с флагом «Норма».
// Через переадресатор с COM — договор forwarder/hl7-oru.js: MSH-4 =
// LabPC, номер — OBR-3, код — OBX-3 («206^^AUTOBIO»), подпись — OBX-4.
const A_QRY = ['MSH|^~\\&|||||20261001101500||QRY^Q01|3|P|2.3.1',
  'QRD|20261001101500|R|D|7|||RD|LAB-000201|OTH|||T', 'QRF|A1000|20261001000000|20261001101500|||RCT|COR|ALL'].join('\r');
// LIS_VENDOR_EXACT_V1 (D9; решение владельца 2026-10-06, п. 5) — flags: флаги
// прибора в NTE-3 (2-е повторение). У A1000 клиники 832 из 949 результатов
// несут CEX (истекла калибровка; realtest\verify\a1000\reports\flags-decoded.txt).
const A_ORU = (label, value, flags = '') => ['MSH|^~\\&|||||20261005120000||ORU^R01|5|P|2.3.1|261005120000123',
  'PID|||SYN-PAT-1', `OBR|1|${label}|7764|SYSID-SYN`, `NTE|||LOT-SYN~${flags}~Vitamin B12~206~~RACK-SYN~1`,
  `OBX|10455|CE|206|206|5981666^${value}~||||||F|||2026/10/05 12:00:00`].join('\r');
const FWD_ORU = (label) => ['MSH|^~\\&|AutoLumo A1000|LabPC|||20261001101600||ORU^R01|5|P|2.3.1',
  `OBR|1||${label}|`, 'OBX|1|NM|206^^AUTOBIO|Vitamin B12|390.946|pg/mL|||||F'].join('\r');

test('A1000: по сети (HL7, как пишет прибор) и через переадресатор с COM — одна панель, код 206, в бланке концентрация числом, флаг по диапазону клиники; запрос QRY^Q01 — DSR^Q01 «заказов нет»', async () => {
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
      assert.deepEqual([dev.profile, dev.name], ['', 'Анализатор 127.0.0.3'], 'A1000 себя не называет — модели нет');
      // Лаборатория: «Добавить» — модель «AutoLumo A1000» выбрана вручную
      // (обязательный шаг настройки A1000); диапазон клиники для B12, пг/мл.
      db.prepare("UPDATE lab_devices SET added = 1, profile = 'autobio-autolumo-a1000', model_confirmed = 1 WHERE id = ?").run(dev.id);
      bindPanel(db, { id: 6, serviceId: 10, deviceId: dev.id, name: 'Витамин B12', lines: [['B12', 'Витамин B12', 'пг/мл', '206']] });
      db.prepare('UPDATE lab_panel_analytes SET ref_low = 187, ref_high = 883 WHERE panel_id = 6').run();

      // Значение с десятичной запятой (Windows прибора с русскими настройками)
      // и самым частым флагом прибора клиники — CEX (LIS_VENDOR_EXACT_V1, D9:
      // предупреждение о сроке калибровки запись не останавливает).
      const ack = await net1.send(A_ORU('LAB-000201', '1250,5', 'CEX'));
      assert.equal(fieldOf(ack, 'MSH', 9), 'ACK^R01');
      assert.match(ack, /\rMSA\|AA\|5\|/, 'MSH-10 = 5 эхом');
      assert.equal(fieldOf(ack, 'MSA', 4), '10455', 'MSA-4 = OBX-1: A1000 отмечает результат «Accepted»');
      assert.equal(last(db).status, 'applied');
      assert.deepEqual(blank(db, 201), { 'Витамин B12': '1250.5' }, 'компонент 2 — концентрация, не «5981666^1250,5»; запятая — точка');
      const b12 = db.prepare('SELECT numeric_value, flag FROM lab_results WHERE visit_service_id = 201').get();
      assert.deepEqual(b12, { numeric_value: 1250.5, flag: 'high' }, 'CE — число: диапазон клиники ставит «Выше», а не «Норма»');
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
// строку и подтвердить номера тестов заново (подтверждение помнит прибор, для
// которого дано, — ревью R4, мигр. 233), потом «Привязать» ждущие строки.
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

    // Лаборатория: панель — на новую строку. Ревью R4, п. A: подтверждения
    // помнят прибор — они даны для старой строки и для новой не действуют.
    db.prepare('UPDATE lab_panels SET device_id = ? WHERE id = 5').run(newDev.id);
    const stamps = () => db.prepare('SELECT device_code_confirmed AS c, device_code_confirmed_device_id AS d FROM lab_panel_analytes WHERE panel_id = 5 ORDER BY sort_order')
      .all().map((r) => [r.c, r.d]);
    assert.deepEqual(stamps(), [[1, oldDev.id], [1, oldDev.id], [1, oldDev.id]]);
    // «Привязать» до подтверждения заново — в бланк не легло, лоток говорит, что делать.
    lisMessageAttach(db, { id: waiting[0].id, visit_service_id: 1 }, LAB);
    assert.deepEqual(blank(db, 1), {});
    assert.match(last(db).detail, /подтверждено для другого прибора — подтвердите заново в «Лаборатория → Панели»: Глюкоза \(2\)/);
    // Номера тестов сверены с программой прибора — подтверждены заново в
    // редакторе: сохранение вставляет строки с прибором, для которого человек
    // подтвердил (lab-panels.js savePanel), и удаляет прежние.
    const oldRows = db.prepare('SELECT * FROM lab_panel_analytes WHERE panel_id = 5 ORDER BY sort_order').all();
    for (const r of oldRows) {
      db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed, device_code_confirmed_device_id, device_code_confirmed_epoch)
                  VALUES (5, ?, ?, ?, ?, ?, 1, ?, ?)`).run(r.code, r.name, r.unit, r.sort_order, r.device_code, newDev.id, newDev.code_epoch);
      db.prepare('DELETE FROM lab_panel_analytes WHERE id = ?').run(r.id);
    }
    assert.deepEqual(stamps(), [[1, newDev.id], [1, newDev.id], [1, newDev.id]]);
    for (const m of tray(db)) lisMessageAttach(db, { id: m.id, visit_service_id: 1 }, LAB);
    assert.deepEqual(blank(db, 1), { 'Глюкоза': '5', 'Мочевина': '10', 'Расчётный': '15' });
    assert.deepEqual(tray(db), [], '«Необработанные» пусты');
    assert.equal(last(db).status, 'applied');
    // 4: строка глюкозы, «Привязанная» до повторного подтверждения, — тоже
    // член серии (строки, которых коснулся человек, в серию входят; бланк
    // судится по записанному).
    assert.match(last(db).detail, /серия из 4 сообщений принята/);
    notReleased(db, 1);
  });
});

// ── LIS_VENDOR_EXACT_V1 — Mindray BS-240 и CL-900i, как пишут приборы ───────
// BS-240 — расположение полей настоящих записей BS-240 (2017) и BS-240E (2026)
// и руководства BS-360E/BS-240Pro/BS-240E V1.0: MSH-3/4 пусты, OBR-2 —
// штрихкод, OBR-3 — внутренний номер прибора («must not be analyzed by the
// server»), OBX-3 — Channel No., OBX-4 — имя, OBX-13 — исходное значение;
// «нет результата» — «-268435455.000000»; контроль — MSH-16 = 2, MSH + OBR, в
// OBR-2 — номер теста. Значения синтетические. Прибор себя не называет —
// заведён «по адресу» с моделью BS-240.
let b2Id = 0;
const B240 = (obr2, obr3, obx) => [`MSH|^~\\&|||||20260528122129||ORU^R01|${++b2Id}|P|2.3.1||||0||ASCII|||`,
  'PID|1|||||||O|||||||||||||||||||||||',
  `OBR|1|${obr2}|${obr3}|^|N|20260528115302|20260528115240|20260528115240||1^1||||20260528115240|Serum`, ...obx].join('\r');
const B240_GLU = (v) => `OBX|1|NM|Glu-G|Glucose (GOD-POD Method)|${v}|mmol/L|-|N|||F||${v}|20260528122129|||0||`;
const B240_QC = () => [`MSH|^~\\&|||||20260528120000||ORU^R01|${++b2Id}|P|2.3.1||||2||ASCII|||`,
  'OBR|1|1|Glu-G|^|0|20260528115000|20260528115000|20260528115900|||1|2|QUAL1|1111|20280101|0|M|5.500000|0.300000|5.430000|mmol/L|||||||||1||||||||||||||||||'].join('\r');

test('BS-240 (как пишет прибор): номер пробирки из OBR-2, внутренний номер в OBR-3 — приманка; «нет результата» — в лоток; контроль — мимо бланков', async () => {
  await withClinic(async (db, lisPort) => {
    db.prepare("INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, added, dial) VALUES (9, 'Биохимия BS-240', 'mindray-bs-240', 'mllp', '127.0.0.8', ?, 1, 1, 0)").run(lisPort);
    bindPanel(db, { id: 8, serviceId: 9, deviceId: 9, name: 'Биохимия', lines: [['GLU', 'Глюкоза', 'ммоль/л', 'Glu-G'], ['UREA', 'Мочевина', 'ммоль/л', 'UREA']] });
    await startLisListeners(db, { log: () => {} });
    const bs = await analyzer(lisPort, '127.0.0.8');
    try {
      // 1. Контроль: в OBR-2 — номер теста «1»; заказ № 1 — открытая свежая
      //    биохимия другого пациента.
      const qc = await bs.send(B240_QC());
      assert.equal(fieldOf(qc, 'MSH', 9), 'ACK^R01');
      assert.match(qc, /\rMSA\|AA\|/);
      let m = last(db);
      assert.deepEqual([m.kind, m.status, m.visit_service_id, !!m.resolved_at], ['qc', 'unmatched', null, true]);

      // 2. Без штрихкода: OBR-3 = «1» — внутренний номер прибора, не номер пробирки.
      await bs.send(B240('', '1', [B240_GLU('5.900000')]));
      m = last(db);
      assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['unmatched', null, '']);

      // 3. Этикетка в OBR-2, приманка «2» в OBR-3; мочевина не посчитана.
      const ack = await bs.send(B240('LAB-000123', '2', [B240_GLU('5.123400'),
        'OBX|2|NM|UREA|Urea|-268435455.000000||-|N|||F||0.000000|19000101000000|||0||']));
      assert.match(ack, /\rMSA\|AA\|/);
      m = last(db);
      assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['unmapped', 123, 'LAB-000123']);
      assert.equal(m.detail, 'не пришли: Мочевина (UREA, прибор: нет результата «-268435455.000000», OBX-13 «0.000000» — для сверки, в бланк не пишется)');
      assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1234' }, '«нет результата» в бланк не легло');
      assert.deepEqual(blank(db, 1), {}, 'заказ № 1 чужого пациента не тронут');
      assert.deepEqual(blank(db, 2), {}, 'заказ № 2 чужого пациента не тронут');
      notReleased(db, 123);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_devices').get().c, 1, 'находок нет');
    } finally { bs.close(); }
  });
});

// CL-900i — Host Interface Manual CL (2013-08; диалект журналов сервисного
// руководства CL-900i): MSH-3/4 пусты, OBR-2 — штрихкод, OBR-3 — номер пробы
// прибора, OBX-3 — Routine Channel No., OBX-8 «N» всегда, качественный ответ —
// OBX-9; контроль — MSH-16 = 2 (пример руководства, с. 1-28). Значения
// синтетические.
let clId = 0;
const CL9 = (obr2, obr3, obx) => [`MSH|^~\\&|||||20261005101500||ORU^R01|${++clId}|P|2.3.1||||0||ASCII|||`,
  'PID|1|P1|||SYN^PAT||19800101|F|||||||||||||||||||||',
  `OBR|1|${obr2}|${obr3}|^|N|20261005100000|20261005100000|20261005100000|||||||serum||||||||||||||||||||||||||`, ...obx].join('\r');
const CL9_QC = () => [`MSH|^~\\&|||||20120508103014||ORU^R01|${++clId}|P|2.3.1||||2||ASCII|||`,
  'OBR|1|7|AST|^|0|20130729160839|20120405141255|20130729161552|||1|2|QUAL2|2222|20300101|0|M|55.000000|5.000000|0.137470|nkat/L|||||||||1||||||||||||||||||'].join('\r');

test('CL-900i (как пишет прибор): положительный HBsAg (OBX-9) — «Отклонение», не «Норма»; номер пробы прибора в OBR-3 — приманка; контроль — мимо бланков', async () => {
  await withClinic(async (db, lisPort) => {
    db.prepare("INSERT INTO services (id, name, is_lab) VALUES (12, 'Иммунохимия', 1)").run();
    const now = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (10, 56, 12, 'in_progress', ${now}), (125, 55, 12, 'queued', ${now})`).run();
    db.prepare("INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, added, dial) VALUES (10, 'ИХЛА 900i', 'mindray-cl-900i', 'mllp', '127.0.0.9', ?, 1, 1, 0)").run(lisPort);
    bindPanel(db, { id: 9, serviceId: 12, deviceId: 10, name: 'Иммунохимия', lines: [['TSH', 'ТТГ', 'мкМЕ/мл', 'TSH'], ['HBS', 'HBsAg', 'COI', 'HBsAg']] });
    await startLisListeners(db, { log: () => {} });
    const cl = await analyzer(lisPort, '127.0.0.9');
    try {
      const qc = await cl.send(CL9_QC());
      assert.equal(fieldOf(qc, 'MSH', 9), 'ACK^R01');
      assert.equal(last(db).kind, 'qc', 'контроль (MSH-16 = 2) — служебное');

      await cl.send(CL9('', '10', ['OBX|1|NM|TSH|TSH|2.350000|uIU/mL|-|N|||F||2.350000|20261005101400||admin|0|']));
      assert.deepEqual([last(db).status, last(db).visit_service_id], ['unmatched', null], 'номер пробы прибора «10» — не номер пробирки');
      assert.deepEqual(blank(db, 10), {}, 'заказ № 10 чужого пациента не тронут');

      const ack = await cl.send(CL9('LAB-000125', '10', [
        'OBX|1|NM|TSH|TSH|2.350000|uIU/mL|-|N|||F||2.350000|20261005101400||admin|0|',
        'OBX|2|ST|HBsAg|HBsAg|5.320000|COI|-|N|Positive+||F||5.320000|20261005101400||admin|0|']));
      assert.match(ack, /\rMSA\|AA\|/);
      assert.equal(last(db).status, 'applied', last(db).detail);
      assert.deepEqual(blank(db, 125), { 'ТТГ': '2.35', 'HBsAg': '5.32' });
      const hbsag = db.prepare("SELECT numeric_value, flag, reference_range FROM lab_results WHERE visit_service_id = 125 AND parameter = 'HBsAg'").get();
      assert.deepEqual(hbsag, { numeric_value: 5.32, flag: 'abnormal', reference_range: '' }, 'положительный — «Отклонение»; OBX-7 «-» — не диапазон');
      assert.deepEqual(blank(db, 10), {});
      notReleased(db, 125);
    } finally { cl.close(); }
  });
});

// ═══ LIS_VENDOR_EXACT_V1 — раунд 2 (сопоставление и запись), сквозь настоящий слушатель ═══
// Решения владельца 2026-10-06 (analyzer-research\fix\DECISIONS.md): п. 2 —
// одна пробирка заполняет все услуги визита (D3); п. 4 — голые цифры только
// номером с этикетки (6 цифр). И остатки приёмки: N1 — значение прибора в
// черновике молча не меняется; N2 — находка до «Добавить» в бланки не пишет;
// п. 5 — устаревшие строки лотка закрываются, когда заказ заполнен.

/** Услуги-панели визита пациента: [номер услуги, имя, код строки, поле анализатора]; заказы — [номер, услуга, визит]. */
function servicesFor(db, deviceId, services, orders) {
  const now = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
  for (const [svc, name, code, deviceCode] of services) {
    db.prepare('INSERT INTO services (id, name, is_lab) VALUES (?, ?, 1)').run(svc, name);
    bindPanel(db, { id: svc, serviceId: svc, deviceId, name, lines: [[code, name, '', deviceCode]] });
  }
  for (const [id, svc, visit] of orders) {
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (?, ?, ?, 'queued', ${now})`).run(id, visit, svc);
  }
}

test('D3 сквозь слушатель: CL-900i — ТТГ, Т4 св. и Т3 св. тремя услугами, одна пробирка — три бланка; та же услуга другого пациента не тронута', async () => {
  await withClinic(async (db, lisPort) => {
    db.prepare("INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, added, dial) VALUES (11, 'ИХЛА 900i', 'mindray-cl-900i', 'mllp', '127.0.0.10', ?, 1, 1, 0)").run(lisPort);
    servicesFor(db, 11, [[13, 'ТТГ', 'TSH', 'TSH'], [14, 'Т4 свободный', 'FT4', 'FT4'], [15, 'Т3 свободный', 'FT3', 'FT3']],
      [[601, 13, 55], [602, 14, 55], [603, 15, 55], [604, 14, 56]]);
    await startLisListeners(db, { log: () => {} });
    const cl = await analyzer(lisPort, '127.0.0.10');
    try {
      const ack = await cl.send(CL9('LAB-000601', '10', [
        'OBX|1|NM|TSH|TSH|2.350000|uIU/mL|-|N|||F||2.350000|20261005101400||admin|0|',
        'OBX|2|NM|FT4|FT4|15.200000|pmol/L|-|N|||F||15.200000|20261005101400||admin|0|',
        'OBX|3|NM|FT3|FT3|4.100000|pmol/L|-|N|||F||4.100000|20261005101400||admin|0|']));
      assert.match(ack, /\rMSA\|AA\|/);
      const m = last(db);
      assert.deepEqual([m.status, m.visit_service_id], ['applied', 601], m.detail);
      assert.deepEqual([blank(db, 601), blank(db, 602), blank(db, 603)], [{ 'ТТГ': '2.35' }, { 'Т4 свободный': '15.2' }, { 'Т3 свободный': '4.1' }]);
      for (const id of [601, 602, 603]) notReleased(db, id);
      assert.deepEqual(blank(db, 604), {}, 'другой визит — другой пациент');
      assert.deepEqual(tray(db), []);
    } finally { cl.close(); }
  });
});

test('D3, N2, п. 5 сквозь слушатель: BS-200 (приёмка T8) — находка в бланк не пишет; после «Добавить» Глюкоза и АЛТ отдельными услугами — каждая в свою, лоток пуст', async () => {
  await withClinic(async (db, lisPort) => {
    const now = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
    db.prepare(`INSERT INTO visits (id, patient_id, visit_date, status) VALUES (58, 3, ${now}, 'scheduled')`).run();
    db.prepare("INSERT INTO services (id, name, is_lab) VALUES (16, 'Глюкоза', 1), (17, 'АЛТ', 1)").run();
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (701, 58, 16, 'queued', ${now}), (702, 58, 17, 'queued', ${now})`).run();
    await startLisListeners(db, { log: () => {} });
    const bs = await analyzer(lisPort, '127.0.0.11');
    try {
      // Прибор заговорил впервые — найден сам, ещё не добавлен: проба в лотке.
      await bs.send(BS_ORU('LAB-000701', 'GLU', 'Glucose', '5.100000'));
      const dev = db.prepare("SELECT * FROM lab_devices WHERE host = '127.0.0.11'").get();
      assert.deepEqual([dev.added, dev.profile], [0, 'mindray-bs-200']);
      const found = last(db);
      assert.equal(found.detail, 'прибор ещё не добавлен — «Анализаторы» → «Добавить прибор» → «Найдены в сети» → «Добавить»');
      assert.deepEqual([found.visit_service_id, blank(db, 701)], [701, {}], 'в бланк не легло ничего; строка — при заказе (этикетка)');
      // «Добавить» (модель — BS-200) и панели двух услуг на этот прибор.
      db.prepare('UPDATE lab_devices SET added = 1, model_confirmed = 1 WHERE id = ?').run(dev.id);
      bindPanel(db, { id: 16, serviceId: 16, deviceId: dev.id, name: 'Глюкоза', lines: [['GLU', 'Глюкоза', '', 'GLU']] });
      bindPanel(db, { id: 17, serviceId: 17, deviceId: dev.id, name: 'АЛТ', lines: [['ALT', 'АЛТ', '', 'ALT']] });

      await bs.send(BS_ORU('LAB-000701', 'GLU', 'Glucose', '5.100000'));
      assert.deepEqual([last(db).status, last(db).visit_service_id], ['applied', 701]);
      assert.ok(db.prepare('SELECT resolved_at FROM lab_device_messages WHERE id = ?').get(found.id).resolved_at, 'строка «не добавлен» закрыта той же пробой');
      await bs.send(BS_ORU('LAB-000701', 'ALT', 'ALT', '85.300000'));
      const alt = last(db);
      assert.deepEqual([alt.status, alt.visit_service_id], ['applied', 702], alt.detail);
      assert.doesNotMatch(alt.detail, /не пришли/);
      assert.deepEqual([blank(db, 701), blank(db, 702)], [{ 'Глюкоза': '5.1' }, { 'АЛТ': '85.3' }]);
      notReleased(db, 701); notReleased(db, 702);
      assert.deepEqual(tray(db), [], '«Необработанные» пусты');
    } finally { bs.close(); }
  });
});

test('п. 4 сквозь слушатель: A1000 — номер лаборатории «5» и контроль «3» (без PID) — приманки № 3 и № 5 не тронуты; номер с этикетки «000201» — принят', async () => {
  await withClinic(async (db, lisPort) => {
    const now = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (3, 56, 10, 'queued', ${now}), (5, 56, 10, 'queued', ${now})`).run();
    db.prepare("INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, added, dial, model_confirmed) VALUES (12, 'A1000', 'autobio-autolumo-a1000', 'mllp', '127.0.0.12', ?, 1, 1, 0, 1)").run(lisPort);
    bindPanel(db, { id: 10, serviceId: 10, deviceId: 12, name: 'Витамин B12', lines: [['B12', 'Витамин B12', 'пг/мл', '206']] });
    await startLisListeners(db, { log: () => {} });
    const a = await analyzer(lisPort, '127.0.0.12');
    try {
      // Номер лаборатории «5» (приёмка A1000 T6b: автономер) — не номер заказа.
      assert.match(await a.send(A_ORU('5', '390.1')), /\rMSA\|AA\|5\|/);
      assert.deepEqual([last(db).status, last(db).visit_service_id], ['unmatched', null]);
      assert.match(last(db).detail, /^номер пробы «5» короче 6 цифр/);
      // Контроль (приёмка T7a; кодировщик: без PID, номер контроля).
      await a.send(['MSH|^~\\&|||||20261006123256||ORU^R01|5|P|2.3.1|261006123256749', 'OBR|1|3|7766|Autolumo 1000',
        'NTE|||SYNLOT1~~Vitamin B12~206~~R001~2', 'OBX|10457|CE|206|206|52000^25.1~||||||F|||2026/10/06 12:32:56'].join('\r'));
      assert.equal(last(db).visit_service_id, null);
      assert.deepEqual([blank(db, 3), blank(db, 5)], [{}, {}], 'чужие бланки не тронуты');
      // Номер с этикетки без LAB- — как напечатан под штрихкодом.
      await a.send(A_ORU('000201', '390.1'));
      assert.deepEqual([last(db).status, last(db).visit_service_id], ['applied', 201], last(db).detail);
      assert.deepEqual(blank(db, 201), { 'Витамин B12': '390.1' });
    } finally { a.close(); }
  });
});

test('N1 сквозь слушатель: BC-5300 — вторая пробирка с той же этикеткой (автоприращение) — в лотке «повтор», бланк не тронут; «Привязать» принимает новые', async () => {
  await withClinic(async (db, lisPort) => {
    db.prepare("INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, added, dial, model_confirmed) VALUES (13, 'BC-5300', 'mindray-bc-5300', 'mllp', '127.0.0.13', ?, 1, 1, 0, 1)").run(lisPort);
    OAK(db, 13);
    await startLisListeners(db, { log: () => {} });
    const bc = await analyzer(lisPort, '127.0.0.13');
    // BC-5300 — пример руководства (OM13, прил. C): номер пробы — OBR-3.
    const B53 = (label, wbc, hgb, id) => [`MSH|^~\\&|BC-5300|Mindray|||20261006133432||ORU^R01|${id}|P|2.3.1||||||UNICODE`,
      'PID|1||T0001^^^^MR||Тестов^Анализатор||19900101000000|Мужской', 'PV1|1|Амбулаторно|Терапия^^12',
      `OBR|1||${label}|00001^Automated Count^99MRC|||20261006133432|||||||||||||||||HM||||||||Лаборант`,
      'OBX|1|IS|08001^Take Mode^99MRC||O||||||F', `OBX|2|NM|6690-2^WBC^LN||${wbc}|10*9/L||N|||F`, `OBX|3|NM|718-7^HGB^LN||${hgb}|g/L||N|||F`].join('\r');
    try {
      await bc.send(B53('LAB-000302', '5.40', '128', 1));
      assert.equal(last(db).status, 'applied');
      assert.match(await bc.send(B53('LAB-000302', '14.20', '146', 2)), /\rMSA\|AA\|2\|/, 'сохранено — повторять незачем');
      const held = last(db);
      assert.equal(held.status, 'unmapped');
      assert.match(held.detail, /^повтор: значения отличаются от уже записанных \(Лейкоциты 5\.40 → 14\.20, Гемоглобин 128 → 146\) — проверьте пробу; принять новые значения — «Привязать»/);
      assert.deepEqual(blank(db, 302), { 'Лейкоциты': '5.40', 'Гемоглобин': '128' }, 'черновик молча не переписан');
      await bc.send(B53('LAB-000302', '5.4', '128', 3));   // тот же прогон ещё раз — повторная передача
      assert.equal(last(db).status, 'applied');
      assert.deepEqual(tray(db).map((r) => r.id), [held.id], 'в лотке — только «повтор»');
      const out = lisMessageAttach(db, { id: held.id, visit_service_id: 302 }, LAB);
      assert.equal(out.status, 'applied', out.detail);
      assert.deepEqual(blank(db, 302), { 'Лейкоциты': '14.20', 'Гемоглобин': '146' }, 'человек принял новые значения');
      assert.deepEqual(tray(db), []);
      notReleased(db, 302);
    } finally { bc.close(); }
  });
});
