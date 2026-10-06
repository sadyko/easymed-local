// index.test.js — проводка слушателей анализаторов (LIS_MINDRAY_CODES_V1,
// ревью 2026-09-28): сообщение больше потолка не пропадает, а ложится в лоток
// «Необработанные» как «Не разобрано», с началом текста и номером пробы.
//
// Слушатель настоящий: startLisListeners на свободном порту через LIS_PORT.
// Порт по умолчанию (2575) на машине разработчика занят запущенным Easy-Med.
// Сырой net на обеих сторонах — ограничение fetch про «плохие» порты здесь не
// действует (оно про HTTP-клиент).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { startLisListeners, stopLisListeners, listenerStatus } from './index.js';
import { VT, FS, DEFAULT_MAX_BYTES } from './mllp.js';
import { OVERSIZE_DETAIL_PREFIX } from './inbox.js';   // LIS_DISCOVERY_FIX_V1 — по нему привязка узнаёт обрезанное
import { ABANDONED_DETAIL_PREFIX } from './inbox.js';   // LIS_REAL_ANALYZERS_V1 — ревью R2, п. 10
import { selfPorts } from './index.js';   // LIS_REAL_ANALYZERS_V1_DIAL — порты самого Easy-Med (нет петли на себя)
import { dialPlan } from './index.js';   // LIS_REAL_ANALYZERS_V1 — ревью R3, п. 11
import { lisRestart, lisDeviceDelete, lisListeners } from '../services/rpc/lis.js';   // LIS_REAL_ANALYZERS_V1_DIAL

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '0.0.0.0', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

function connect(port) {
  return new Promise((res, rej) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => res(sock));
    sock.on('error', rej);
  });
}

/** Ждёт ОДИН кадр ответа. */
function readFrame(sock) {
  return new Promise((res, rej) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => rej(new Error('ответ не пришёл за 10 с')), 10000);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf(FS);
      if (end !== -1) { clearTimeout(timer); res(buf.slice(1, end).toString('utf8')); }
    });
  });
}

test('сообщение больше потолка: прибору AE, в лотке — «Не разобрано» с началом текста и номером пробы', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const port = await freePort();
  const prevPort = process.env.LIS_PORT;
  process.env.LIS_PORT = String(port);
  const logs = [];
  try {
    const running = await startLisListeners(db, { log: (m) => logs.push(m) });
    assert.equal(running.length, 1, 'слушатель поднят: ' + logs.join(' | '));

    const head = [
      'MSH|^~\\&|BC-5380|Mindray|||20260928120000||ORU^R01|555|P|2.3.1',
      'OBR|1||LAB-000123|00001^Automated Count^99MRC',
      'OBX|1|NM|6690-2^WBC^LN||9.81|10*9/L|||||F',
      'OBX|2|ED|15551-4^WBC Histogram. BMP^99MRC||^Image^BMP^Base64^',
    ].join('\r');
    const sock = await connect(port);
    sock.on('error', () => {});   // сервер закрывает соединение — это и проверяется
    const reply = readFrame(sock);
    // Картинка больше потолка: кадр так и не закрывается.
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(head, 'utf8'), Buffer.alloc(DEFAULT_MAX_BYTES + 64 * 1024, 0x51)]));
    assert.match(await reply, /MSA\|AE\|555/, 'прибор видит отказ с номером своего сообщения');
    sock.destroy();

    let row = null;
    for (let i = 0; i < 50 && !row; i++) {
      row = db.prepare('SELECT * FROM lab_device_messages ORDER BY id DESC LIMIT 1').get();
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(row, 'переросшее сообщение записано');
    assert.equal(row.status, 'rejected', 'в лотке — «Не разобрано»');
    assert.equal(row.device_id, null);
    assert.equal(row.peer, '127.0.0.1');
    assert.equal(row.sample_id, 'LAB-000123', 'по номеру пробы лаборант узнаёт, чья проба не дошла');
    assert.match(row.detail, /сообщение больше 4 МБ — не принято/);
    assert.ok(row.detail.startsWith(OVERSIZE_DETAIL_PREFIX), 'по этому началу «Привязать» отказывает (rpc/lis.js)');
    assert.match(row.raw, /^MSH\|/);
    assert.ok(row.raw.length <= 64 * 1024, 'в лотке — начало, а не 4 МБ картинок: ' + row.raw.length);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_devices').get().c, 0,
      'прибор по началу не заводится: целого сообщения нет');
  } finally {
    await stopLisListeners();
    if (prevPort === undefined) delete process.env.LIS_PORT; else process.env.LIS_PORT = prevPort;
    db.close();
  }
});

// LIS_REAL_ANALYZERS_V1_SAMPLE — номер пробы переросшего сообщения ищет та же
// pickSampleId с проводом default: этикетка LAB- узнаётся и в OBR-2, а голое
// «2» из OBR-3 рядом с ней не побеждает.
test('переросшее сообщение: номер пробы — pickSampleId (default), LAB- в OBR-2 бьёт голое в OBR-3', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const port = await freePort();
  const prevPort = process.env.LIS_PORT;
  process.env.LIS_PORT = String(port);
  try {
    await startLisListeners(db, { log: () => {} });
    const head = [
      'MSH|^~\\&|BC-780|Mindray|||20261001090000||ORU^R01|556|P|2.3.1||||||UNICODE',
      'OBR|1|LAB-000123|2|00001^Automated Count^99MRC',
      'OBX|1|ED|15551-4^WBC Histogram. BMP^99MRC||^Image^BMP^Base64^',
    ].join('\r');
    const sock = await connect(port);
    sock.on('error', () => {});
    const reply = readFrame(sock);
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(head, 'utf8'), Buffer.alloc(DEFAULT_MAX_BYTES + 64 * 1024, 0x51)]));
    assert.match(await reply, /MSA\|AE\|556/);
    sock.destroy();
    let row = null;
    for (let i = 0; i < 50 && !row; i++) {
      row = db.prepare('SELECT * FROM lab_device_messages ORDER BY id DESC LIMIT 1').get();
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(row, 'переросшее сообщение записано');
    assert.equal(row.sample_id, 'LAB-000123');
  } finally {
    await stopLisListeners();
    if (prevPort === undefined) delete process.env.LIS_PORT; else process.env.LIS_PORT = prevPort;
    db.close();
  }
});

// LIS_ANALYZER_LIST_V1 — порт, который не поднялся, виден экрану, а не только
// в журнале сервера: строка «порт N не слушается» у ждущего прибора.
test('занятый порт виден как «не слушается», а не пропадает молча', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '0.0.0.0', r));
  const busy = blocker.address().port;
  const prev = process.env.LIS_PORT;
  process.env.LIS_PORT = String(busy);
  const db = openDb(':memory:');
  migrate(db);
  try {
    await startLisListeners(db, { log: () => {} });
    const st = listenerStatus();
    // Ревью M6: code — то, по чему экран выбирает свои слова; error — для журнала.
    assert.ok(st.failed.some((f) => f.port === busy && f.code === 'busy' && f.error), JSON.stringify(st));
    assert.ok(!st.listening.includes(busy));
  } finally {
    await stopLisListeners();
    await new Promise((r) => blocker.close(r));
    if (prev === undefined) delete process.env.LIS_PORT; else process.env.LIS_PORT = prev;
    db.close();
  }
});

// Ревью M6 — отказ не из-за занятости (здесь — невозможный номер порта) —
// код 'error': экран скажет «порт N не слушается», без сырого текста сервера.
test('порт не поднялся не из-за занятости — код error', async () => {
  const prev = process.env.LIS_PORT;
  process.env.LIS_PORT = '70000';
  const db = openDb(':memory:');
  migrate(db);
  try {
    await startLisListeners(db, { log: () => {} });
    const st = listenerStatus();
    assert.ok(st.failed.some((f) => f.port === 70000 && f.code === 'error' && f.error), JSON.stringify(st));
  } finally {
    await stopLisListeners();
    if (prev === undefined) delete process.env.LIS_PORT; else process.env.LIS_PORT = prev;
    db.close();
  }
});

// ── LIS_REAL_ANALYZERS_V1_SERVICE — проводка через receive ─────────────────
// Запрос рабочего списка — разобранное сообщение: прибор, который сначала
// спросил, появляется в «Найдены в сети» с первого запроса. Ответ — не ACK, а
// QCK^Q02 «заказов нет» (руководство BS-200, с. 28); в лотке пусто.
test('QRY^Q02 по проводу: ответ QCK^Q02 NF, прибор заведён, служебная строка разрешена', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const port = await freePort();
  const prevPort = process.env.LIS_PORT;
  process.env.LIS_PORT = String(port);
  try {
    await startLisListeners(db, { log: () => {} });
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from([
      'MSH|^~\\&|Mindray|BS-200E|||20070723170707||QRY^Q02|1|P|2.3.1||||||ASCII|||',
      'QRD|20070723170707|R|D|1|||RD|34567743|OTH|||T|',
      'QRF|BS-200E|20070723170749|20070723170749|||RCT|COR|ALL||',
    ].join('\r'), 'utf8'), Buffer.from([FS, 0x0d])]));
    const text = await reply;
    sock.destroy();
    const lines = text.split('\r');
    assert.equal(lines[0].split('|')[8], 'QCK^Q02', text);
    // LIS_VENDOR_EXACT_V1 — вид руководства (HIM v5.0, с. 27): «|» в конце
    // MSA, ERR и QAK, CR после последнего сегмента.
    assert.equal(lines[1], 'MSA|AA|1|Message accepted|||0|');
    assert.equal(lines[3], 'QAK|SR|NF|');
    assert.equal(lines[4], '', 'CR после QAK');

    const dev = db.prepare('SELECT * FROM lab_devices').all();
    assert.equal(dev.length, 1, 'прибор, который спросил, заведён');
    assert.equal(dev[0].discovered, 1);
    assert.equal(dev[0].sending_app, 'Mindray');
    assert.ok(dev[0].last_seen_at, 'на связи');
    const m = db.prepare('SELECT * FROM lab_device_messages').get();
    assert.equal(m.kind, 'query');
    assert.equal(m.device_id, dev[0].id);
    assert.ok(m.resolved_at, 'в «Необработанных» пусто');
  } finally {
    await stopLisListeners();
    if (prevPort === undefined) delete process.env.LIS_PORT; else process.env.LIS_PORT = prevPort;
    db.close();
  }
});

// LIS_VENDOR_EXACT_V1 — приём бросил (здесь — запись в журнал сообщений
// отказывает): ответ строит сам провод, и он тоже в виде прибора — по тому, как
// сообщение назвало себя (receive.js replyStyle): BS-200 — вид руководства с
// AR 207 (AE у химии — только 100–103, HIM v5.0, с. 9), BC-5300 — короткий AE 207.
test('LIS_VENDOR_EXACT_V1 D1: приём бросил — ответ провода в виде прибора: BS-200 — AR 207 вида руководства, BC-5300 — короткий AE 207', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const port = await freePort();
  const prevPort = process.env.LIS_PORT;
  process.env.LIS_PORT = String(port);
  try {
    await startLisListeners(db, { log: () => {} });
    db.exec("CREATE TRIGGER no_messages BEFORE INSERT ON lab_device_messages BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const sock = await connect(port);
    let reply = readFrame(sock);
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from('MSH|^~\\&|Mindray|BS-200|||20261005101500||QRY^Q02|8|P|2.3.1||||||ASCII|||\rQRD|20261005101500|R|D|1|||RD|LAB-000123|OTH|||T|\rQRF|BS-200|||||RCT|COR|ALL||\r', 'utf8'), Buffer.from([FS, 0x0d])]));
    const chem = await reply;
    sock.removeAllListeners('data');
    reply = readFrame(sock);
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from('MSH|^~\\&|BC-5300|Mindray|||20080419104618||ORU^R01|32|P|2.3.1||||||UNICODE\rOBR|1||LAB-000127|00001^Automated Count^99MRC\r', 'utf8'), Buffer.from([FS, 0x0d])]));
    const heme = await reply;
    sock.destroy();
    assert.equal(chem.split('\r')[0].split('|').length, 21, 'MSH до MSH-20: ' + chem);
    assert.equal(chem.split('\r')[1], 'MSA|AR|8|Application internal error|||207|');
    assert.equal(heme.split('\r')[1], 'MSA|AE|32|Application internal error|||207');
    assert.ok(heme.endsWith('|207\r'), 'CR после последнего сегмента');
  } finally {
    await stopLisListeners();
    if (prevPort === undefined) delete process.env.LIS_PORT; else process.env.LIS_PORT = prevPort;
    db.close();
  }
});

// Неподдержанный тип (ADT^A01) прибора не заводит, как и прежде: заводит
// только то, что разобрано как результат или служебное.
test('ADT^A01 по проводу: AR 200, прибор не заводится, строка rejected в лотке', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const port = await freePort();
  const prevPort = process.env.LIS_PORT;
  process.env.LIS_PORT = String(port);
  try {
    await startLisListeners(db, { log: () => {} });
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from('MSH|^~\\&|BC-5300|Mindray|||20260910143943||ADT^A01|43|P|2.3.1', 'utf8'), Buffer.from([FS, 0x0d])]));
    const text = await reply;
    sock.destroy();
    assert.match(text, /MSA\|AR\|43\|Unsupported message type\|\|\|200/);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_devices').get().c, 0);
    const m = db.prepare('SELECT * FROM lab_device_messages').get();
    assert.equal(m.status, 'rejected');
    assert.equal(m.resolved_at, null);
  } finally {
    await stopLisListeners();
    if (prevPort === undefined) delete process.env.LIS_PORT; else process.env.LIS_PORT = prevPort;
    db.close();
  }
});

// ── LIS_REAL_ANALYZERS_V1_MODEL — слушатель передаёт MSH-4 в ensureDevice ────
// BS-200 называет себя «Mindray|BS-200E»: модель — в MSH-4. Находка помнит его
// (sending_facility) и угадывает модель по нему.
test('BS-200 по проводу: находка с моделью mindray-bs-200 и MSH-4 «BS-200E»', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const port = await freePort();
  const prevPort = process.env.LIS_PORT;
  process.env.LIS_PORT = String(port);
  try {
    await startLisListeners(db, { log: () => {} });
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from([
      'MSH|^~\&|Mindray|BS-200E|||20261001101500||ORU^R01|1|P|2.3.1||||0||ASCII|||',
      'OBR|1|LAB-000123|2|Mindray^BS-200E|Y',
      'OBX|1|NM|2|test2|5.000000|g/ml|-||||F|||||||',
    ].join('\r'), 'utf8'), Buffer.from([FS, 0x0d])]));
    assert.match(await reply, /MSA\|AA\|1\|/);
    sock.destroy();
    const dev = db.prepare('SELECT * FROM lab_devices').all();
    assert.equal(dev.length, 1);
    assert.deepEqual([dev[0].sending_app, dev[0].sending_facility, dev[0].profile], ['Mindray', 'BS-200E', 'mindray-bs-200']);
  } finally {
    await stopLisListeners();
    if (prevPort === undefined) delete process.env.LIS_PORT; else process.env.LIS_PORT = prevPort;
    db.close();
  }
});

// ── LIS_REAL_ANALYZERS_V1_DIAL — Easy-Med подключается к прибору сам ────────
// Строка прибора с dial = 1: слушатели её порт не берут, а клиент звонит на
// адрес и порт строки. Поддельный анализатор-сервер — 127.0.0.1, порт 0; номер
// берётся заново, если совпал с портом самого Easy-Med (LIS, HTTP, EasyPhone):
// такой адрес клиент по правилу «нет петли на себя» и не тронет.
async function fakeAnalyzer() {
  for (;;) {
    const conns = [];
    const acks = [];
    const server = net.createServer((sock) => {
      conns.push(sock);
      sock.on('error', () => {});
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
const frameOf = (s) => Buffer.concat([Buffer.from([VT]), Buffer.from(s, 'utf8'), Buffer.from([FS, 0x0d])]);
const dialRow = (db, { id, host = '127.0.0.1', port, enabled = 1, name = 'BC-780' }) => db.prepare(
  "INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, dial) VALUES (?, ?, 'mindray-bc-780', 'mllp', ?, ?, ?, 1)",
).run(id, name, host, port, enabled);
const dialing = (id) => listenerStatus().dialing.find((d) => d.device_id === id);

/** Свежая база и свободный порт LIS; fn(db, lisPort). Слушатели и клиенты гасятся всегда. */
async function withLis(fn) {
  const db = openDb(':memory:');
  migrate(db);
  const lisPort = await freePort();
  const prevPort = process.env.LIS_PORT;
  process.env.LIS_PORT = String(lisPort);
  try { await fn(db, lisPort); } finally {
    await stopLisListeners();
    if (prevPort === undefined) delete process.env.LIS_PORT; else process.env.LIS_PORT = prevPort;
    db.close();
  }
}

test('строка dial = 1: клиент звонит прибору, её порт не слушается; проба — тот же приём, ответ ACK^R01', async () => {
  const fake = await fakeAnalyzer();
  try {
    await withLis(async (db, lisPort) => {
      dialRow(db, { id: 7, port: fake.port });
      await startLisListeners(db, { log: () => {} });
      const st = listenerStatus();
      assert.ok(st.listening.includes(lisPort), 'порт по умолчанию слушается, как всегда');
      assert.ok(!st.listening.includes(fake.port), 'порт прибора Easy-Med не слушает');
      await until(() => fake.live().length === 1, 5000, 'подключение');
      await until(() => dialing(7) && dialing(7).state === 'connected', 5000, 'connected');
      const d = dialing(7);
      assert.deepEqual([d.host, d.port, d.code], ['127.0.0.1', fake.port, null]);
      assert.ok(d.since);

      fake.live()[0].write(frameOf([
        'MSH|^~\\&|BC-780|Mindray|||20261001090000||ORU^R01|11|P|2.3.1||||||UNICODE',
        'OBR|1||LAB-000999|00001^Automated Count^99MRC',
        'OBX|1|NM|6690-2^WBC^LN||7.25|10*9/L|4.0-10.0|N|||F',
      ].join('\r')));
      await until(() => fake.acks.length === 1, 5000, 'ответ');
      assert.equal(fake.acks[0].split('\r')[0].split('|')[8], 'ACK^R01');
      assert.match(fake.acks[0], /MSA\|AA\|11\|/);

      const m = db.prepare('SELECT * FROM lab_device_messages').get();
      assert.equal(m.device_id, 7, 'прибор известен заранее — сообщение его');
      assert.equal(m.peer, '127.0.0.1');
      assert.equal(m.status, 'unmatched', 'тот же приём: заказа LAB-000999 нет');
      const dev = db.prepare('SELECT * FROM lab_devices WHERE id = 7').get();
      assert.deepEqual([dev.sending_app, dev.sending_facility], ['BC-780', 'Mindray'], 'как назвался — дописано');
      assert.ok(dev.last_seen_at, 'на связи');
      assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_devices').get().c, 1, 'ensureDevice не зовётся — находок нет');
      assert.ok(dialing(7).last_rx_at);
    });
  } finally { await fake.close(); }
});

test('дубль адреса: вторая строка с тем же адресом и портом клиента не поднимает', async () => {
  const fake = await fakeAnalyzer();
  try {
    await withLis(async (db) => {
      dialRow(db, { id: 7, port: fake.port });
      dialRow(db, { id: 8, port: fake.port, name: 'BC-780 (2)' });
      await startLisListeners(db, { log: () => {} });
      await until(() => dialing(7) && dialing(7).state === 'connected', 5000, 'connected');
      assert.deepEqual([dialing(8).state, dialing(8).code], ['off', 'duplicate']);
      await sleep(200);
      assert.equal(fake.conns.length, 1, 'один прибор — одно соединение');
    });
  } finally { await fake.close(); }
});

test('адрес не из локальной сети, имя вместо IP, порт не задан, петля на себя — отказ с кодом, без подключения', async () => {
  await withLis(async (db, lisPort) => {
    dialRow(db, { id: 1, host: '8.8.8.8', port: 5600 });
    dialRow(db, { id: 2, host: 'analyzer.local', port: 5600 });
    db.prepare("INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, dial) VALUES (3, 'Без порта', '', 'mllp', '10.0.0.30', NULL, 1, 1)").run();
    dialRow(db, { id: 4, host: '127.0.0.1', port: lisPort });
    dialRow(db, { id: 5, host: '', port: 5600 });
    dialRow(db, { id: 6, host: '127.0.0.1', port: 5600, enabled: 0 });
    await startLisListeners(db, { log: () => {} });
    const codes = Object.fromEntries(listenerStatus().dialing.map((d) => [d.device_id, d.state + ':' + d.code]));
    assert.deepEqual(codes, { 1: 'off:bad_address', 2: 'off:bad_address', 3: 'off:bad_address', 4: 'off:self', 5: 'off:bad_address' },
      'выключенный прибор не звонит и не значится');
    assert.ok(!listenerStatus().listening.includes(5600), 'порт строки dial не слушается и при отказе');
  });
});

test('selfPorts: порты LIS, HTTP и EasyPhone', () => {
  const prev = [process.env.PORT, process.env.EASYPHONE_PORT];
  try {
    process.env.PORT = '8100';
    delete process.env.EASYPHONE_PORT;
    assert.deepEqual(selfPorts([2575]).sort((a, b) => a - b), [2575, 8100, 8120]);
    process.env.EASYPHONE_PORT = '9000';
    assert.ok(selfPorts([]).includes(9000));
  } finally {
    if (prev[0] === undefined) delete process.env.PORT; else process.env.PORT = prev[0];
    if (prev[1] === undefined) delete process.env.EASYPHONE_PORT; else process.env.EASYPHONE_PORT = prev[1];
  }
});

/** LIS_VENDOR_EXACT_V1 — что увидела сторона соединения: 'end' — FIN, код ошибки — RST. */
function trackClose(sock) {
  const ev = [];
  sock.on('data', () => {});
  sock.on('end', () => ev.push('end'));
  sock.on('error', (e) => ev.push(e.code));
  sock.on('close', () => ev.push('close'));
  return ev;
}

// LIS_VENDOR_EXACT_V1 — D4: lis_restart («Сохранить» любого прибора) больше не
// рвёт соединение строки, которая не менялась: прибор, ждущий звонка, иначе
// терял бы результат, сделанный во время переподключения. Удаление прибора —
// рвёт, и RST, а не FIN.
test('lis_restart не рвёт соединение неизменённой строки звонка (LIS_VENDOR_EXACT_V1, D4); lis_device_delete рвёт его RST и не ждёт прибора', async () => {
  const fake = await fakeAnalyzer();
  const LAB = { role: 'lab' };
  try {
    await withLis(async (db) => {
      dialRow(db, { id: 7, port: fake.port });
      await startLisListeners(db, { log: () => {} });
      await until(() => fake.live().length === 1, 5000, 'подключение');
      const first = fake.live()[0];
      const ev = trackClose(first);

      let t = Date.now();
      await lisRestart(db, {}, LAB);
      assert.ok(Date.now() - t < 2000, 'перезапуск не висит на открытом соединении прибора');
      await sleep(300);
      assert.deepEqual(ev, [], 'строка не менялась — соединение не тронуто');
      assert.equal(fake.conns.length, 1, 'нового звонка нет');
      assert.equal(lisListeners(db, {}, LAB).dialing.find((d) => d.device_id === 7).state, 'connected');

      t = Date.now();
      const out = await lisDeviceDelete(db, { id: 7 }, LAB);
      assert.equal(out.ok, true);
      assert.ok(Date.now() - t < 2000, 'удаление не висит на открытом соединении прибора');
      await until(() => fake.live().length === 0, 3000, 'соединение порвано удалением');
      await until(() => ev.includes('close'), 3000, 'закрыто');
      assert.ok(ev.includes('ECONNRESET') && !ev.includes('end'), 'RST, а не FIN: ' + ev.join(','));
      await sleep(300);
      assert.equal(fake.conns.length, 1, 'удалённый прибор больше не звонят');
      assert.equal(dialing(7), undefined);
    });
  } finally { await fake.close(); }
});

test('LIS_VENDOR_EXACT_V1 D4: у строки звонка сменили порт — старое соединение RST, звонок — на новый порт', async () => {
  const a = await fakeAnalyzer();
  const b = await fakeAnalyzer();
  const LAB = { role: 'lab' };
  try {
    await withLis(async (db) => {
      dialRow(db, { id: 7, port: a.port });
      await startLisListeners(db, { log: () => {} });
      await until(() => a.live().length === 1, 5000, 'подключение к старому порту');
      const ev = trackClose(a.live()[0]);
      db.prepare('UPDATE lab_devices SET port = ? WHERE id = 7').run(b.port);
      await lisRestart(db, {}, LAB);
      await until(() => b.live().length === 1, 5000, 'подключение к новому порту');
      await until(() => ev.includes('close'), 3000, 'старое закрыто');
      assert.ok(ev.includes('ECONNRESET') && !ev.includes('end'), 'RST, а не FIN: ' + ev.join(','));
      assert.equal(dialing(7).port, b.port);
    });
  } finally { await a.close(); await b.close(); }
});

// LIS_VENDOR_EXACT_V1 — D4: слушатель. A1000 подключается при запуске своей
// программы и может молчать часами; после нашего закрытия он обрыва не
// замечает и теряет следующий результат (settle, находка 6). Раньше каждый
// «Сохранить» прибора (lis_restart) рвал ВСЕ соединения слушателей; теперь —
// только у слушателя, чей порт больше не нужен.
const A1000_TEST = ['MSH|^~\\&|||||20261005120000||ORU^R01|5|P|2.3.1|261005120000123', 'OBR|1|LAB-000123|7764|AutoLumo A1000',
  'NTE|||180323~~AFP~107~20271231~DQ70~1', 'OBX|10455|CE|107|107|41765^4.17~||||||F|||2026/10/05 12:00:00'].join('\r') + '\r';

test('LIS_VENDOR_EXACT_V1 D4: lis_restart при неизменном порте не трогает соединение прибора; результат по нему приходит и после', async () => {
  const LAB = { role: 'lab' };
  await withLis(async (db, lisPort) => {
    await startLisListeners(db, { log: () => {} });
    const sock = await connect(lisPort);
    const ev = trackClose(sock);
    try {
      await sleep(100);
      await lisRestart(db, {}, LAB);
      // «Сохранить» прибора на том же порте — тоже lis_restart.
      db.prepare("INSERT INTO lab_devices (id, name, profile, transport, port, enabled) VALUES (3, 'ИХЛА', 'autobio-autolumo-a1000', 'mllp', ?, 1)").run(lisPort);
      await lisRestart(db, {}, LAB);
      await sleep(300);
      assert.deepEqual(ev, [], 'соединение не тронуто');
      assert.ok(listenerStatus().listening.includes(lisPort));
      const reply = readFrame(sock);
      sock.write(frameOf(A1000_TEST));
      assert.match(await reply, /\rMSA\|AA\|5\|/, 'результат по тому же соединению принят');
    } finally { sock.destroy(); }
  });
});

test('LIS_VENDOR_EXACT_V1 D4: у прибора сменили порт — закрыт только слушатель старого порта, его соединение — RST, а не FIN; порт по умолчанию не тронут', async () => {
  const LAB = { role: 'lab' };
  await withLis(async (db, lisPort) => {
    const p1 = await freePort();
    let p2 = await freePort();
    while (p2 === p1 || p2 === lisPort) p2 = await freePort();
    db.prepare("INSERT INTO lab_devices (id, name, profile, transport, port, enabled) VALUES (4, 'CL-900i', 'mindray-cl-900i', 'mllp', ?, 1)").run(p1);
    await startLisListeners(db, { log: () => {} });
    assert.ok(listenerStatus().listening.includes(p1));
    const onOld = await connect(p1);
    const onDefault = await connect(lisPort);
    const oldEv = trackClose(onOld);
    const defEv = trackClose(onDefault);
    try {
      await sleep(100);
      db.prepare('UPDATE lab_devices SET port = ? WHERE id = 4').run(p2);
      await lisRestart(db, {}, LAB);
      await until(() => oldEv.includes('close'), 3000, 'старое соединение закрыто');
      assert.ok(oldEv.includes('ECONNRESET') && !oldEv.includes('end'), 'RST, а не FIN: ' + oldEv.join(','));
      await sleep(200);
      assert.deepEqual(defEv, [], 'соединение на порте по умолчанию не тронуто');
      const st = listenerStatus();
      assert.ok(st.listening.includes(p2) && !st.listening.includes(p1) && st.listening.includes(lisPort), JSON.stringify(st.listening));
    } finally { onOld.destroy(); onDefault.destroy(); }
  });
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R2 ───────────────────────────────────────

// П. 3 — два запуска слушателей одновременно (два «Перезапустить» подряд,
// удаление во время перезапуска): второй затирал клиента первого в карте, не
// закрыв его, — сирота звонил прибору вечно, а порт LIS второй запуск видел
// «уже занятым». Запуски и остановка теперь идут по очереди.
test('R2 п. 3: два запуска одновременно, потом остановка — ни одного соединения, ни нового звонка, порт не «занят»', async () => {
  const fake = await fakeAnalyzer();
  try {
    await withLis(async (db, lisPort) => {
      dialRow(db, { id: 7, port: fake.port });
      await Promise.all([startLisListeners(db, { log: () => {} }), startLisListeners(db, { log: () => {} })]);
      assert.deepEqual(listenerStatus().failed, [], 'порт LIS не «занят» сам собой');
      assert.ok(listenerStatus().listening.includes(lisPort));
      assert.equal(listenerStatus().dialing.length, 1);
      await until(() => fake.live().length === 1, 5000, 'одно живое соединение');
      await sleep(200);
      assert.equal(fake.live().length, 1, 'сироты нет');
      await stopLisListeners();
      await until(() => fake.live().length === 0, 3000, 'остановка рвёт всё');
      const n = fake.conns.length;
      await sleep(400);
      assert.equal(fake.conns.length, n, 'после остановки никто не звонит');
    });
  } finally { await fake.close(); }
});

// П. 7 — дубль адреса сравнивался строкой: «127.0.0.1» и «::ffff:127.0.0.1»
// давали два соединения с одним прибором.
test('R2 п. 7: дубль адреса — после приведения: «::ffff:127.0.0.1» = «127.0.0.1», «0:0:0:0:0:0:0:1» = «::1»', async () => {
  const fake = await fakeAnalyzer();
  try {
    await withLis(async (db) => {
      dialRow(db, { id: 7, port: fake.port });
      dialRow(db, { id: 8, host: '::ffff:127.0.0.1', port: fake.port, name: 'BC-780 (2)' });
      dialRow(db, { id: 9, host: '::1', port: 5611 });
      dialRow(db, { id: 10, host: '0:0:0:0:0:0:0:1', port: 5611 });
      await startLisListeners(db, { log: () => {} });
      await until(() => dialing(7) && dialing(7).state === 'connected', 5000, 'connected');
      assert.deepEqual([dialing(8).state, dialing(8).code], ['off', 'duplicate']);
      assert.deepEqual([dialing(10).state, dialing(10).code], ['off', 'duplicate']);
      await sleep(200);
      assert.equal(fake.conns.length, 1, 'один прибор — одно соединение');
    });
  } finally { await fake.close(); }
});

// П. 10 — читатель кадров (общий у слушателя и звонка).
test('R2 п. 10а: брошенный кадр и следом новый — новый принят, в лотке одна строка «кадр оборван»', async () => {
  await withLis(async (db, lisPort) => {
    await startLisListeners(db, { log: () => {} });
    const sock = await connect(lisPort);
    try {
      const reply = readFrame(sock);
      const partial = 'MSH|^~\\&|BC-5300|Mindray|||20261001090000||ORU^R01|61|P|2.3.1\rOBR|1||LAB-000123|00001^Automated Count^99MRC\rOBX|1|NM|WBC^^99MRC||6.';
      const full = 'MSH|^~\\&|BC-5300|Mindray|||20261001090000||ORU^R01|62|P|2.3.1\rOBR|1||LAB-000999|00001^Automated Count^99MRC\rOBX|1|NM|WBC^^99MRC||7.1|10*9/L|||||F';
      sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(partial, 'utf8'), frameOf(full)]));
      assert.match(await reply, /MSA\|AA\|62\|/, 'ответ — на новый кадр, с его номером');
      await until(() => db.prepare('SELECT COUNT(*) c FROM lab_device_messages').get().c === 2, 3000, 'две строки');
      const rows = db.prepare('SELECT * FROM lab_device_messages ORDER BY id').all();
      const cut = rows.find((r) => r.status === 'rejected');
      assert.ok(cut, JSON.stringify(rows.map((r) => [r.status, r.detail])));
      assert.ok(cut.detail.startsWith(ABANDONED_DETAIL_PREFIX), cut.detail);
      assert.equal(cut.raw, partial, 'в лотке — начало брошенного кадра');
      assert.equal(cut.sample_id, 'LAB-000123');
      const ok = rows.find((r) => r.status !== 'rejected');
      assert.equal(ok.raw, full, 'новый кадр — целиком, без начала брошенного');
    } finally { sock.destroy(); }
  });
});

test('R2 п. 10б: переросшее с одного адреса — одна строка лотка в час, а не на каждое переподключение', async () => {
  await withLis(async (db, lisPort) => {
    await startLisListeners(db, { log: () => {} });
    const head = 'MSH|^~\\&|BC-5380|Mindray|||20260928120000||ORU^R01|555|P|2.3.1\rOBR|1||LAB-000123|00001^Automated Count^99MRC\r';
    for (let i = 0; i < 3; i++) {
      const sock = await connect(lisPort);
      sock.on('error', () => {});
      const reply = readFrame(sock);
      sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(head, 'utf8'), Buffer.alloc(DEFAULT_MAX_BYTES + 1024, 0x51)]));
      assert.match(await reply, /MSA\|AE\|555/, 'прибор каждый раз видит отказ');
      sock.destroy();
    }
    await sleep(300);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM lab_device_messages WHERE status = 'rejected'").get().c, 1);
  });
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R3 ───────────────────────────────────────

// П. 4 — «одна строка в час» гасила РАЗНЫЕ пробы: ключ был только прибор
// (адрес) и вид строки. Теперь и номер пробы (без номера — начало сообщения):
// повтор той же пробы — одна строка, другая проба — своя.
async function abandon(lisPort, partial, full) {
  const sock = await connect(lisPort);
  try {
    const reply = readFrame(sock);
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(partial, 'utf8'), frameOf(full)]));
    await reply;
  } finally { sock.destroy(); }
}
const HEAD = (id, label) => `MSH|^~\\&|BC-5300|Mindray|||20261001090000||ORU^R01|${id}|P|2.3.1\rOBR|1||${label}|00001^Automated Count^99MRC\rOBX|1|NM|WBC^^99MRC||6.`;
const FULL = (id) => `MSH|^~\\&|BC-5300|Mindray|||20261001090000||ORU^R01|${id}|P|2.3.1\rOBR|1||LAB-000999|00001^Automated Count^99MRC\rOBX|1|NM|WBC^^99MRC||7.1|10*9/L|||||F`;
const rejectedRows = (db) => db.prepare("SELECT sample_id, raw FROM lab_device_messages WHERE status = 'rejected' ORDER BY id").all();

test('R3 п. 4: брошенные кадры разных проб — каждый своей строкой; та же проба повторно — одна', async () => {
  await withLis(async (db, lisPort) => {
    await startLisListeners(db, { log: () => {} });
    await abandon(lisPort, HEAD(61, 'LAB-000123'), FULL(62));
    await abandon(lisPort, HEAD(63, 'LAB-000124'), FULL(64));
    await abandon(lisPort, HEAD(61, 'LAB-000123'), FULL(65));
    await until(() => db.prepare('SELECT COUNT(*) c FROM lab_device_messages').get().c >= 5, 3000, 'строки');
    await sleep(100);
    assert.deepEqual(rejectedRows(db).map((r) => r.sample_id), ['LAB-000123', 'LAB-000124']);
  });
});

test('R3 п. 4: переросшие сообщения разных проб — каждое своей строкой; без номера — по началу сообщения', async () => {
  await withLis(async (db, lisPort) => {
    await startLisListeners(db, { log: () => {} });
    const send = async (head) => {
      const sock = await connect(lisPort);
      sock.on('error', () => {});
      const reply = readFrame(sock);
      sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(head, 'utf8'), Buffer.alloc(DEFAULT_MAX_BYTES + 1024, 0x51)]));
      await reply;
      sock.destroy();
    };
    const head = (id, label) => `MSH|^~\\&|BC-5380|Mindray|||20260928120000||ORU^R01|${id}|P|2.3.1\rOBR|1||${label}|00001^Automated Count^99MRC\r`;
    await send(head(555, 'LAB-000123'));
    await send(head(556, 'LAB-000124'));
    await send(head(557, ''));
    await send(head(558, ''));
    await send(head(557, ''));
    await sleep(300);
    const rows = rejectedRows(db);
    assert.deepEqual(rows.map((r) => r.sample_id), ['LAB-000123', 'LAB-000124', '', ''], 'две пробы с номером и две разные без номера');
  });
});

// П. 11 — зона IPv6 («%2») отбрасывается только для сравнения и ключа дубля;
// звонят по адресу строки, как прежде, — с зоной.
test('R3 п. 11: dialPlan — дубль по адресу без зоны, звонок — по адресу строки с зоной', () => {
  const plan = dialPlan([
    { id: 1, name: 'A', host: 'fe80::1%2', port: 5600 },
    { id: 2, name: 'B', host: 'fe80::1%3', port: 5600 },
    { id: 3, name: 'C', host: '::ffff:10.0.0.9', port: 5600 },
    { id: 4, name: 'D', host: '10.0.0.9', port: 5600 },
  ], [2575]);
  const by = Object.fromEntries(plan.map((p) => [p.device_id, p]));
  assert.deepEqual([by[1].code, by[1].host], [null, 'fe80::1%2'], 'звонок — с зоной');
  assert.equal(by[2].code, 'duplicate');
  assert.deepEqual([by[3].code, by[3].host], [null, '::ffff:10.0.0.9']);
  assert.equal(by[4].code, 'duplicate');
});

// LIS_REAL_ANALYZERS_V1 — ревью R4, п. E: зона — только у IPv6. «10.0.0.5%eth0»
// набирается как «10.0.0.5»; адрес, который с зоной не IP (две зоны, пустая
// зона), — bad_address: такой «адрес» ушёл бы в DNS.
test('R4 п. E: dialPlan — у IPv4 зона отбрасывается и для звонка; зона только у IPv6; негодная зона — bad_address', () => {
  const plan = dialPlan([
    { id: 1, name: 'A', host: '10.0.0.5%eth0', port: 5600 },
    { id: 2, name: 'B', host: '::ffff:10.0.0.6%eth0', port: 5600 },
    { id: 3, name: 'C', host: 'fe80::1%eth0', port: 5600 },
    { id: 4, name: 'D', host: 'fe80::2%eth0%x', port: 5600 },
    { id: 5, name: 'E', host: 'fe80::3%', port: 5600 },
    { id: 6, name: 'F', host: '10.0.0.5', port: 5600 },
  ], [2575]);
  const by = Object.fromEntries(plan.map((p) => [p.device_id, p]));
  assert.deepEqual([by[1].code, by[1].host], [null, '10.0.0.5']);
  assert.deepEqual([by[2].code, by[2].host], [null, '::ffff:10.0.0.6']);
  assert.deepEqual([by[3].code, by[3].host], [null, 'fe80::1%eth0']);
  assert.equal(by[4].code, 'bad_address');
  assert.equal(by[5].code, 'bad_address');
  assert.equal(by[6].code, 'duplicate', '«10.0.0.5%eth0» и «10.0.0.5» — один прибор');
});

// ── LIS_VENDOR_EXACT_V1 — D14: кто подключался к порту приёма ───────────────
// Договор с экраном «Анализаторы» (lis_listeners → lab-devices-lists.js
// peerNotes): listenerStatus().peers — [{ ip, port, connectedAt, lastRxAt,
// frames, noiseBytes, noiseHint, open }]; port — порт приёма; noiseHint —
// 'astm' | 'autobio' | 'utf16' | 'hl7-unframed' | 'other' | null.
test('LIS_VENDOR_EXACT_V1 D14: listenerStatus().peers — соединения с портом приёма по договору с экраном; подключение и байты не в кадре — в журнале', async () => {
  await withLis(async (db, lisPort) => {
    const logs = [];
    await startLisListeners(db, { log: (m) => logs.push(m) });
    const sock = await connect(lisPort);
    sock.on('error', () => {});
    const mine = sock.localPort;
    try {
      // A1000 с «Protocol type = ASTM» (autobio-autolumo-a1000.md §2): ENQ.
      sock.write(Buffer.from([0x05]));
      await until(() => (listenerStatus().peers || []).some((p) => p.noiseHint === 'astm'), 3000, 'подсказка ASTM');
      let p = listenerStatus().peers.find((x) => x.remotePort === mine);
      assert.deepEqual(
        [p.ip, p.port, p.frames, p.noiseBytes, p.noiseHint, p.open],
        ['127.0.0.1', lisPort, 0, 1, 'astm', true], JSON.stringify(p));
      assert.ok(p.connectedAt && p.lastRxAt);
      assert.ok(logs.some((l) => l.includes('127.0.0.1:' + mine) && /подключ/.test(l)), 'подключение — в журнале: ' + logs.join(' | '));
      assert.ok(logs.some((l) => /не в кадре/.test(l) && /ASTM/.test(l)), 'байты не в кадре — в журнале с подсказкой');
      // Потом прибор переключили на HL7 — кадр принят, счёт кадров растёт.
      const reply = readFrame(sock);
      sock.write(frameOf(A1000_TEST));
      await reply;
      p = listenerStatus().peers.find((x) => x.remotePort === mine);
      assert.equal(p.frames, 1);
    } finally { sock.destroy(); }
    await until(() => listenerStatus().peers.find((x) => x.remotePort === mine).open === false, 3000, 'закрыто');
  });
});

// ── LIS_VENDOR_EXACT_V1 — D1/D9/D13 по настоящему слушателю ─────────────────
// Сквозная сверка: кадр прибора → находка (discover.js) → приём (receive.js) →
// ответ → кадр MLLP — байт в байт со строками набора захвата
// (analyzer-research\notes\capture-kit\tests\run-tests.ps1), кроме MSH-3/4 =
// EASYMED|CLINIC (наши, HIM v5.0 с. 8), MSH-5/6 гематологии (эхо её MSH-3/4) и
// MSH-7 (время). Каждый прибор — со своего адреса петли, как в клинике.
async function kitAnalyzer(port, localAddress) {
  const sock = net.createConnection({ host: '127.0.0.1', port, localAddress });
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  sock.on('error', () => {});
  let buf = Buffer.alloc(0);
  const frames = [];
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const s = buf.indexOf(VT);
      const e = buf.indexOf(FS, s + 1);
      if (s === -1 || e === -1 || buf.length < e + 2) break;
      frames.push(buf.subarray(s, e + 2));
      buf = buf.subarray(e + 2);
    }
  });
  return {
    async send(text) {
      const n = frames.length;
      sock.write(frameOf(text));
      await until(() => frames.length > n, 10000, 'ответ Easy-Med');
      return frames[n];
    },
    close() { sock.destroy(); },
  };
}
const kitSegs = (...s) => s.join('\r') + '\r';
/** Кадр ответа из строки набора: VT + текст + FS CR; {TS} — MSH-7 ответа; MSH-3/4 — EASYMED|CLINIC. */
function kitFrame(kit, got, { msh5, msh6, msh10 } = {}) {
  const text = got.subarray(1, got.length - 2).toString('latin1');
  const [mshLine, ...rest] = kit.replace('{TS}', text.split('|')[6]).split('\r');
  const f = mshLine.split('|');
  f[2] = 'EASYMED';
  f[3] = 'CLINIC';
  if (msh5 !== undefined) f[4] = msh5;
  if (msh6 !== undefined) f[5] = msh6;
  if (msh10 !== undefined) f[9] = msh10;
  return Buffer.concat([Buffer.from([VT]), Buffer.from([f.join('|'), ...rest].join('\r'), 'latin1'), Buffer.from([FS, 0x0d])]);
}
/** Разрез BS200.exe: кусок n всего ответа (notes\bs200-probes\manual-check-pieces.mjs). */
const kitPiece = (frame, n) => frame.subarray(1, frame.length - 2).toString('latin1').split('|').slice(0, -1)[n - 1];

test('LIS_VENDOR_EXACT_V1: по настоящему слушателю — ответ каждому прибору клиники байт в байт со строками набора захвата', async () => {
  await withLis(async (db, lisPort) => {
    // A1000 — строка с моделью (D2: «Добавить» — только с моделью), его MSH-3/4 пусты.
    db.prepare("INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, added) VALUES (21, 'ИХЛА', 'autobio-autolumo-a1000', 'mllp', '127.0.0.25', ?, 1, 1)").run(lisPort);
    await startLisListeners(db, { log: () => {} });
    const bs = await kitAnalyzer(lisPort, '127.0.0.22');
    const cl = await kitAnalyzer(lisPort, '127.0.0.23');
    const bc = await kitAnalyzer(lisPort, '127.0.0.24');
    const ab = await kitAnalyzer(lisPort, '127.0.0.25');
    try {
      // BS-200 — X_BS200_ACK и X_BS200_QCK; куски 10, 27, 32 BS200.exe.
      let got = await bs.send(kitSegs('MSH|^~\\&|Mindray|BS-200|||20261005101500||ORU^R01|17|P|2.3.1||||0||ASCII|||', 'PID|1',
        'OBR|1|LAB-000123|12|Mindray^BS-200|N||20261005101200||||||||serum', 'OBX|1|NM|GLU|Glucose|5.230000|mmol/L|3.900000-6.100000|N|||F|||20261005101200'));
      assert.deepEqual(got, kitFrame('MSH|^~\\&|||Mindray|BS-200|{TS}||ACK^R01|17|P|2.3.1||||0||ASCII|||\rMSA|AA|17|Message accepted|||0|\r', got));
      assert.deepEqual([kitPiece(got, 10), kitPiece(got, 27)], ['17', '0']);
      got = await bs.send(kitSegs('MSH|^~\\&|Mindray|BS-200|||20261005101500||QRY^Q02|8|P|2.3.1||||||ASCII|||', 'QRD|20261005101500|R|D|1|||RD|LAB-000123|OTH|||T|', 'QRF|BS-200|||||RCT|COR|ALL||'));
      assert.deepEqual(got, kitFrame('MSH|^~\\&|||Mindray|BS-200|{TS}||QCK^Q02|8|P|2.3.1||||||ASCII|||\rMSA|AA|8|Message accepted|||0|\rERR|0|\rQAK|SR|NF|\r', got));
      assert.deepEqual([kitPiece(got, 10), kitPiece(got, 27), kitPiece(got, 32)], ['8', '0', 'NF']);

      // CL-900i (BS-240 — так же): MSH-3/4 пусты — X_CL_ACK, X_CL_ACK_QC, X_CL_QCK; 19 «|» после «^~\&».
      got = await cl.send(kitSegs('MSH|^~\\&|||||20120508094822||ORU^R01|1|P|2.3.1||||0||ASCII|||', 'PID|1|TEST-0001|||||||||||||||||||||||||||',
        'OBR|1|LAB-000125|10|^|Y|20120405193926|20120405193914|20120405193914||||||20120405193914|serum|||||||||3|||||||||||||||||||||||',
        'OBX|1|NM|2|TBil|100| umol/L |-|N|||F||100|20120405194245||tester|0|'));
      assert.deepEqual(got, kitFrame('MSH|^~\\&|||||{TS}||ACK^R01|1|P|2.3.1||||0||ASCII|||\rMSA|AA|1|Message accepted|||0|\r', got));
      const msh = got.subarray(1).toString('latin1').split('\r')[0];
      assert.equal((msh.slice(msh.indexOf('^~\\&') + 4).match(/\|/g) || []).length, 19, 'CL-900i: «MSH segment field count < 19» — нет');
      got = await cl.send(kitSegs('MSH|^~\\&|||||20120508103014||ORU^R01|1|P|2.3.1||||2||ASCII|||',
        'OBR|1|7|AST|^|0|20130729160839|20120405141255|20130729161552|||1|2|QUAL2|2222|20300101|0|M|55.000000|5.000000|0.137470|nkat/L|||||||||1||||||||||||||||||'));
      assert.deepEqual(got, kitFrame('MSH|^~\\&|||||{TS}||ACK^R01|1|P|2.3.1||||2||ASCII|||\rMSA|AA|1|Message accepted|||0|\r', got));
      got = await cl.send(kitSegs('MSH|^~\\&|||||20190222102859||QRY^Q02|10|P|2.3.1||||||ASCII|||', 'QRD|20190222102859|R|D|9|||RD|LAB-000126|OTH|||T|', 'QRF||||||RCT|COR|ALL||'));
      assert.deepEqual(got, kitFrame('MSH|^~\\&|||||{TS}||QCK^Q02|10|P|2.3.1||||||ASCII|||\rMSA|AA|10|Message accepted|||0|\rERR|0|\rQAK|SR|NF|\r', got));

      // BC-5300 — X_HEME_ACK, X_HEME_ACK_QC (MSH-11 = Q), X_HEME_ORR; MSA-3/6 у ACK — как сегодня.
      got = await bc.send(kitSegs('MSH|^~\\&|BC-5300|Mindray|||20080419104618||ORU^R01|42|P|2.3.1||||||UNICODE', 'PID|1||TEST-0002^^^^MR', 'PV1|1',
        'OBR|1||LAB-000127|00001^Automated Count^99MRC||20071207080000|20071207160000|||Mindray||||20071207083000||||||||||HM||||||||Mindray',
        'OBX|6|NM|6690-2^WBC^LN||4.63|10*9/L|11.00-12.00|L|||F||E'));
      assert.deepEqual(got, kitFrame('MSH|^~\\&|LIS||||{TS}||ACK^R01|42|P|2.3.1||||||UNICODE\rMSA|AA|42|Message accepted|||0\r', got, { msh5: 'BC-5300', msh6: 'Mindray' }));
      got = await bc.send(kitSegs('MSH|^~\\&|BC-5300|Mindray|||20081120171602||ORU^R01|1|Q|2.3.1||||||UNICODE', 'PID|1||LOT1234^^^^MR||||20301231',
        'OBR|1||6|00003^LJ QCR^99MRC||||||||||||||||||||HM', 'OBX|1|NM|6690-2^WBC^LN||7.10|10*9/L|||||F'));
      assert.deepEqual(got, kitFrame('MSH|^~\\&|LIS||||{TS}||ACK^R01|1|Q|2.3.1||||||UNICODE\rMSA|AA|1|Message accepted|||0\r', got, { msh5: 'BC-5300', msh6: 'Mindray' }));
      got = await bc.send(kitSegs('MSH|^~\\&|BC-5300|Mindray|||20081120174836||ORM^O01|9|P|2.3.1||||||UNICODE', 'ORC|RF||SampleID1||IP'));
      assert.deepEqual(got, kitFrame('MSH|^~\\&|LIS||||{TS}||ORR^O02|1|P|2.3.1||||||UNICODE\rMSA|AR|9\r', got, { msh5: 'BC-5300', msh6: 'Mindray', msh10: '9' }));

      // A1000 — «Mindray long form» с MSA-4 (settle, табл. c, R1 и R5).
      got = await ab.send(kitSegs('MSH|^~\\&|||||20261005120000||ORU^R01|5|P|2.3.1|261005120000123', 'OBR|1|LAB-000123|7764|AutoLumo A1000',
        'NTE|||180323~~AFP~107~20271231~DQ70~1', 'OBX|10455|CE|107|107|41765^4.17~||||||F|||2026/10/05 12:00:00'));
      assert.deepEqual(got, kitFrame('MSH|^~\\&|||||{TS}||ACK^R01|5|P|2.3.1||||||ASCII|||\rMSA|AA|5|Message accepted|10455||0|\r', got));
      got = await ab.send(kitSegs('MSH|^~\\&|||||20261005120000||ORU^R01|7|P|2.3.1|261005120000124', 'OBR|1|LAB-000123|7764|AutoLumo A1000',
        'OBX||CE|107||41765^4.17||||||F', 'OBX||CE|112||22000^1.23||||||F'));
      assert.deepEqual(got, kitFrame('MSH|^~\\&|||||{TS}||ACK^R01|7|P|2.3.1||||||ASCII|||\rMSA|AA|7|Message accepted|7764||0|\r', got));
      assert.equal(db.prepare("SELECT COUNT(*) c FROM lab_devices WHERE host = '127.0.0.25'").get().c, 1, 'A1000 — его строка, не находка');
    } finally { bs.close(); cl.close(); bc.close(); ab.close(); }
  });
});
