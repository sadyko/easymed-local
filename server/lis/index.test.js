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
