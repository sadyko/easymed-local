// mllp.test.js — кадрирование и ответ. Приём подменён заглушкой: этот файл
// проверяет ПРОВОД, а не смысл сообщения.
//
// Порт берётся динамический (listen(0)). Известное ограничение Windows про
// запрещённые порты здесь не действует: оно про HTTP-клиент fetch, а тут сырой
// net на обеих сторонах.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startMllpServer, VT, FS, CR } from './mllp.js';

const frame = (s) => Buffer.concat([Buffer.from([VT]), Buffer.from(s, 'utf8'), Buffer.from([FS, CR])]);
const MSG = (id) => `MSH|^~\\&|X|Y|||20260910143943||ORU^R01|${id}|P|2.3.1`;

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
    const timer = setTimeout(() => rej(new Error('ответ не пришёл за 3 с')), 3000);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf(FS);
      if (end !== -1) { clearTimeout(timer); res(buf.slice(1, end).toString('utf8')); }
    });
  });
}

async function withServer(onMessage, fn, opts = {}) {
  const srv = await startMllpServer({ port: 0, onMessage, ...opts });
  try { await fn(srv.port); } finally { await srv.close(); }
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('одно сообщение: приходит целиком, в ответ ACK', async () => {
  const seen = [];
  await withServer(async (text) => { seen.push(text); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(frame(MSG('7')));
    assert.match(await reply, /MSA\|AA\|7/);
    sock.end();
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /ORU\^R01/);
});

test('сообщение, разорванное между записями, собирается', async () => {
  const seen = [];
  await withServer(async (t) => { seen.push(t); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    const reply = readFrame(sock);
    const f = frame(MSG('8'));
    sock.write(f.slice(0, 10));
    await settle(40);
    sock.write(f.slice(10));
    await reply;
    sock.end();
  });
  assert.equal(seen.length, 1, 'разрыв по TCP-сегментам не должен терять сообщение');
});

test('два сообщения в одном соединении', async () => {
  const seen = [];
  await withServer(async (t) => { seen.push(t); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    sock.write(Buffer.concat([frame(MSG('1')), frame(MSG('2'))]));
    await settle(250);
    sock.end();
  });
  assert.equal(seen.length, 2);
});

test('слишком большое сообщение отвергается и не копится в памяти', async () => {
  const seen = [];
  await withServer(async (t) => { seen.push(t); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    sock.on('error', () => {});   // сервер рвёт соединение — это и проверяется
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.alloc(4096, 0x41)]));
    await settle(250);
    sock.destroy();
  }, { maxBytes: 1024 });
  assert.equal(seen.length, 0, 'перебор размера не должен доходить до приёма');
});

test('приём бросил — в ответ NAK, чтобы прибор прислал снова', async () => {
  await withServer(async () => { throw new Error('база недоступна'); }, async (port) => {
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(frame(MSG('9')));
    assert.match(await reply, /MSA\|AE\|9/, 'прибор, повторяющий при NAK, здесь помощник, а не помеха');
    sock.end();
  });
});

test('порт сообщает о себе, и закрытие действительно освобождает его', async () => {
  const srv = await startMllpServer({ port: 0, onMessage: async () => 'AA' });
  assert.ok(srv.port > 0);
  await srv.close();
  // Повторное занятие того же номера — доказательство, что слушатель отпустил.
  const again = await startMllpServer({ port: srv.port, onMessage: async () => 'AA' });
  assert.equal(again.port, srv.port);
  await again.close();
});
