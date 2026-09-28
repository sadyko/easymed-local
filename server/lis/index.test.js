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
import { startLisListeners, stopLisListeners } from './index.js';
import { VT, FS, DEFAULT_MAX_BYTES } from './mllp.js';

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
