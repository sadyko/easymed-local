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
    assert.equal(lines[1], 'MSA|AA|1|Message accepted|||0');
    assert.equal(lines[3], 'QAK|SR|NF');

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

test('lis_restart и lis_device_delete рвут соединение и не ждут прибора', async () => {
  const fake = await fakeAnalyzer();
  const LAB = { role: 'lab' };
  try {
    await withLis(async (db) => {
      dialRow(db, { id: 7, port: fake.port });
      await startLisListeners(db, { log: () => {} });
      await until(() => fake.live().length === 1, 5000, 'подключение');
      const first = fake.live()[0];

      let t = Date.now();
      await lisRestart(db, {}, LAB);
      assert.ok(Date.now() - t < 2000, 'перезапуск не висит на открытом соединении прибора');
      await until(() => first.destroyed || first.readableEnded, 3000, 'старое соединение порвано');
      await until(() => fake.live().length === 1 && fake.conns.length === 2, 5000, 'новый клиент подключился');
      assert.equal(lisListeners(db, {}, LAB).dialing.find((d) => d.device_id === 7).state, 'connected');

      t = Date.now();
      const out = await lisDeviceDelete(db, { id: 7 }, LAB);
      assert.equal(out.ok, true);
      assert.ok(Date.now() - t < 2000, 'удаление не висит на открытом соединении прибора');
      await until(() => fake.live().length === 0, 3000, 'соединение порвано удалением');
      await sleep(300);
      assert.equal(fake.conns.length, 2, 'удалённый прибор больше не звонят');
      assert.equal(dialing(7), undefined);
    });
  } finally { await fake.close(); }
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
