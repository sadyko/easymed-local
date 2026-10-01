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

// LIS_ANALYZER_LIST_V1, ревью M6 — занятый порт узнаётся по коду, а не по
// тексту: экран «Анализаторы» пишет «порт N занят другой программой» своими
// словами на языке интерфейса, а не русскую строку сервера.
test('занятый порт: отказ несёт код EADDRINUSE', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '0.0.0.0', r));
  const port = blocker.address().port;
  try {
    await assert.rejects(startMllpServer({ port, onMessage: async () => 'AA' }),
      (e) => e.code === 'EADDRINUSE' && /занят/.test(e.message));
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

// ── LIS_MINDRAY_CODES_V1, ревью 2026-09-28 — потолок и переросшее сообщение ──
// Настоящий Mindray шлёт в пробе гистограммы и скаттерграммы (BMP в base64).
// Такое сообщение больше прежних 256 КБ, и результаты не приходили вовсе:
// соединение рвалось молча — ни NAK, ни записи.

test('сообщение около 1 МБ (проба с картинками) принимается целиком', async () => {
  const seen = [];
  const big = MSG('11') + '\rOBX|1|ED|15551-4^WBC Histogram. BMP^99MRC||^Image^BMP^Base64^' + 'Q'.repeat(1024 * 1024) + '||||||F';
  await withServer(async (t) => { seen.push(t); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(frame(big));
    assert.match(await reply, /MSA\|AA\|11/);
    sock.end();
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, big.length, 'сообщение дошло до приёма целиком');
});

test('переросшее сообщение: прибору AE с его номером, вызывающему — начало текста', async () => {
  const seen = [];
  const over = [];
  const text = MSG('77') + '\rOBR|1||LAB-000123|00001^Automated Count^99MRC\rOBX|1|ED|X^Y^99MRC||' + 'A'.repeat(4096);
  await withServer(async (t) => { seen.push(t); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    sock.on('error', () => {});   // сервер закрывает соединение — это и проверяется
    const reply = readFrame(sock);
    // Кадр не закрыт: прибор ещё шлёт, а потолок уже пройден.
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(text, 'utf8')]));
    assert.match(await reply, /MSA\|AE\|77/, 'прибор видит отказ, а не оборванный провод');
    await settle(50);
    sock.destroy();
  }, { maxBytes: 1024, onOversize: (o) => over.push(o) });
  assert.equal(seen.length, 0, 'переросшее до приёма не доходит');
  assert.equal(over.length, 1, 'вызывающий узнал о переросшем сообщении');
  assert.match(over[0].head, /^MSH\|/, 'начало — с MSH, без 0x0B');
  assert.match(over[0].head, /LAB-000123/);
  assert.ok(over[0].bytes > 1024, 'сколько пришло к моменту отказа: ' + over[0].bytes);
  assert.equal(over[0].limit, 1024);
  assert.ok(over[0].peer, 'адрес отправителя');
});

test('переросший кадр отвергается, даже если пришёл целиком одной записью', async () => {
  const seen = [];
  const over = [];
  await withServer(async (t) => { seen.push(t); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    sock.on('error', () => {});
    const reply = readFrame(sock);
    sock.write(frame(MSG('78') + '\r' + 'B'.repeat(4096)));
    assert.match(await reply, /MSA\|AE\|78/);
    await settle(50);
    sock.destroy();
  }, { maxBytes: 1024, onOversize: (o) => over.push(o) });
  assert.equal(seen.length, 0);
  assert.equal(over.length, 1);
});

test('начало, которое не MSH, — AE без номера; вызывающий всё равно узнаёт', async () => {
  const over = [];
  await withServer(async () => 'AA', async (port) => {
    const sock = await connect(port);
    sock.on('error', () => {});
    const reply = readFrame(sock);
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.alloc(4096, 0x41)]));
    // LIS_REAL_ANALYZERS_V1_ACK — за пустым номером теперь идут MSA-3…6.
    assert.match(await reply, /MSA\|AE\|(\||$)/);
    await settle(50);
    sock.destroy();
  }, { maxBytes: 1024, onOversize: (o) => over.push(o) });
  assert.equal(over.length, 1);
});

test('потолок по умолчанию — 4 МБ', async () => {
  const { DEFAULT_MAX_BYTES } = await import('./mllp.js');
  assert.equal(DEFAULT_MAX_BYTES, 4 * 1024 * 1024);
});

// LIS_DISCOVERY_FIX_V1 (ревью 2026-09-29) — закрытие слушателя не ждёт
// открытого соединения прибора. server.close() ждёт, пока закроются ВСЕ
// соединения, а анализатор держит своё часами (простой рвётся через 5 минут):
// lis_restart и lis_device_delete висели.
test('закрытие не ждёт открытого соединения прибора — рвёт его само', async () => {
  const srv = await startMllpServer({ port: 0, onMessage: async () => 'AA' });
  const sock = await connect(srv.port);
  sock.on('error', () => {});   // сервер рвёт соединение — это и проверяется
  const dropped = new Promise((r) => sock.once('close', r));
  let timer;
  try {
    // Соединение живое: прибор прислал пробу, получил ответ и молчит дальше.
    const reply = readFrame(sock);
    sock.write(frame(MSG('12')));
    assert.match(await reply, /MSA\|AA\|12/);

    const late = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('close() ждёт открытого соединения прибора дольше 2 с')), 2000);
    });
    await Promise.race([srv.close(), late]);
    await Promise.race([dropped, late]);
    assert.ok(sock.destroyed || sock.readableEnded, 'соединение прибора закрыто сервером');
  } finally {
    clearTimeout(timer);
    sock.destroy();
  }
});

// ── LIS_REAL_ANALYZERS_V1_ACK — ответ по руководству BS-200 (с. 8–9, 25) ─────
// Провод отвечает через buildAck(mshOf(…)): ACK^<событие>, эхо MSH-3/4 в
// MSH-5/6, MSH-10/16/18 входящего, MSA-3 и MSA-6.

test('ответ на ORU — ACK^R01 с эхом заголовка и MSA-3/6', async () => {
  const oru = 'MSH|^~\\&|Mindray|BS-200E|||20070719145353||ORU^R01|5|P|2.3.1||||0||ASCII|||';
  await withServer(async () => 'AA', async (port) => {
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(frame(oru));
    const [mshLine, msa] = (await reply).split('\r');
    const f = mshLine.split('|');
    assert.deepEqual([f[2], f[3], f[4], f[5], f[8], f[9], f[15], f[17]],
      ['EASYMED', 'CLINIC', 'Mindray', 'BS-200E', 'ACK^R01', '5', '0', 'ASCII']);
    assert.equal(msa, 'MSA|AA|5|Message accepted|||0');
    sock.end();
  });
});

test('приём ответил AR — прибору AR 200 (известный, но не поддержанный тип)', async () => {
  await withServer(async () => 'AR', async (port) => {
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(frame('MSH|^~\\&|X|Y|||20260910143943||ADT^A01|9|P|2.3.1'));
    const text = await reply;
    assert.match(text, /\|ACK\^A01\|9\|/);
    assert.match(text, /MSA\|AR\|9\|Unsupported message type\|\|\|200/);
    sock.end();
  });
});

test('приём бросил — AE 207 «Application internal error», а не «ошибка разбора»', async () => {
  await withServer(async () => { throw new Error('база недоступна'); }, async (port) => {
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(frame(MSG('21')));
    assert.match(await reply, /MSA\|AE\|21\|Application internal error\|\|\|207/);
    sock.end();
  });
});

test('переросшее сообщение — AE 207 с номером из начала', async () => {
  await withServer(async () => 'AA', async (port) => {
    const sock = await connect(port);
    sock.on('error', () => {});
    const reply = readFrame(sock);
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(MSG('79') + '\r' + 'C'.repeat(4096), 'utf8')]));
    assert.match(await reply, /MSA\|AE\|79\|Application internal error\|\|\|207/);
    await settle(50);
    sock.destroy();
  }, { maxBytes: 1024, onOversize: () => {} });
});
