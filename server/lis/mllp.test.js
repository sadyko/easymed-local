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
    // LIS_VENDOR_EXACT_V1 — без replyStyle (незнакомый прибор) — вид
    // руководства BS-200 (HIM v5.0, с. 25): «|» после MSA-6.
    assert.equal(msa, 'MSA|AA|5|Message accepted|||0|');
    sock.end();
  });
});

// ── LIS_VENDOR_EXACT_V1 — D1: ответ провода в виде прибора ──────────────────
/** Ждёт ОДИН кадр ответа и отдаёт его байты целиком, с VT и FS CR. */
function readFrameBytes(sock) {
  return new Promise((res, rej) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => rej(new Error('ответ не пришёл за 3 с')), 3000);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf(FS);
      if (end !== -1 && buf.length > end + 1) { clearTimeout(timer); res(buf.subarray(0, end + 2)); }
    });
  });
}

test('D1: кадр ответа кончается «|<CR><FS><CR>» — CR после последнего сегмента (HIM v5.0, с. 3, 23: «segments that end with <CR>»)', async () => {
  const oru = 'MSH|^~\\&|Mindray|BS-200|||20261005101500||ORU^R01|17|P|2.3.1||||0||ASCII|||\rPID|1\rOBR|1|LAB-000123|12|Mindray^BS-200|N\rOBX|1|NM|GLU|Glucose|5.230000|mmol/L|3.900000-6.100000|N|||F\r';
  await withServer(async () => 'AA', async (port) => {
    const sock = await connect(port);
    const bytes = readFrameBytes(sock);
    sock.write(frame(oru));
    const b = await bytes;
    assert.equal(b[0], VT);
    assert.deepEqual([...b.subarray(b.length - 4)], [0x7c, CR, FS, CR], '«…0|<CR><FS><CR>», как в примере руководства, с. 25');
    sock.end();
  });
});

test('D1: ответы, которые провод строит сам (приём бросил), — в виде прибора (replyStyle): химия — AR 207 вида руководства, гематология — AE 207 короткий', async () => {
  const bs = 'MSH|^~\\&|Mindray|BS-200|||20261005101500||ORU^R01|31|P|2.3.1||||0||ASCII|||\rPID|1\r';
  const bc = 'MSH|^~\\&|BC-5300|Mindray|||20080419104618||ORU^R01|32|P|2.3.1||||||UNICODE\rPID|1\r';
  const styles = {
    'BS-200': { layout: 'long', wire: 'mindray-chem' },
    'BC-5300': { layout: 'short', wire: 'default' },
  };
  const seen = [];
  await withServer(async () => { throw new Error('база недоступна'); }, async (port) => {
    const sock = await connect(port);
    let reply = readFrame(sock);
    sock.write(frame(bs));
    const chem = await reply;
    sock.removeAllListeners('data');
    reply = readFrame(sock);
    sock.write(frame(bc));
    const heme = await reply;
    // HIM v5.0, с. 9: AE — только 100–103, AR — 200–207.
    assert.equal(chem.split('\r')[1], 'MSA|AR|31|Application internal error|||207|');
    assert.equal(chem.split('\r')[0].split('|').length, 21, 'MSH до MSH-20');
    assert.equal(heme, heme.split('\r')[0] + '\rMSA|AE|32|Application internal error|||207\r');
    assert.ok(!heme.split('\r')[0].endsWith('|'), 'короткий заголовок гематологии');
    sock.end();
  }, { replyStyle: (msh) => { seen.push(msh.app); return styles[msh.app === 'Mindray' ? msh.facility : msh.app]; } });
  assert.deepEqual(seen, ['Mindray', 'BC-5300'], 'вид решает вызывающий — по заголовку входящего (mshOf)');
});

test('D1: переросшее — ответ в виде прибора (replyStyle): химия — AR 207 вида руководства', async () => {
  await withServer(async () => 'AA', async (port) => {
    const sock = await connect(port);
    sock.on('error', () => {});
    const reply = readFrame(sock);
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from('MSH|^~\\&|Mindray|BS-200|||20261005101500||ORU^R01|79|P|2.3.1||||0||ASCII|||\r' + 'C'.repeat(4096), 'utf8')]));
    assert.equal((await reply).split('\r')[1], 'MSA|AR|79|Application internal error|||207|');
    await settle(50);
    sock.destroy();
  }, { maxBytes: 1024, onOversize: () => {}, replyStyle: () => ({ layout: 'long', wire: 'mindray-chem' }) });
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

// LIS_REAL_ANALYZERS_V1_SERVICE — на запрос рабочего списка ответ не ACK, а
// QCK^Q02 / DSR^Q01: приём отдаёт готовый ответ, провод шлёт его как есть.
test('приём отдал готовый ответ ({ reply }) — он и уходит прибору', async () => {
  const qck = 'MSH|^~\\&|EASYMED|CLINIC|Mindray|BS-200E|20261001000000||QCK^Q02|1|P|2.3.1\rMSA|AA|1|Message accepted|||0\rERR|0\rQAK|SR|NF';
  await withServer(async () => ({ code: 'AA', reply: qck }), async (port) => {
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(frame('MSH|^~\\&|Mindray|BS-200E|||20070723170707||QRY^Q02|1|P|2.3.1'));
    assert.equal(await reply, qck);
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

// ── LIS_REAL_ANALYZERS_V1_DIAL — читатель кадров отдельно от сервера ────────
// attachMllpReader — тот же разбор кадров, цепочка ответов, потолок и AE на
// переросшее для сервера (каждое входящее соединение) и для клиента, который
// звонит прибору сам (dial.js). Байты вне кадра (сигнал 0x02 у BC-3600)
// отбрасываются сразу, а не копятся до потолка.

test('байты до VT не копятся: после 4 КБ мусора без VT кадр принимается при потолке 1 КБ', async () => {
  const seen = [];
  const over = [];
  await withServer(async (t) => { seen.push(t); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    for (let i = 0; i < 4; i++) { sock.write(Buffer.alloc(1024, 0x02)); await settle(20); }
    const reply = readFrame(sock);
    sock.write(frame(MSG('31')));
    assert.match(await reply, /MSA\|AA\|31/, 'раньше мусор копился до потолка, и кадр получал AE');
    sock.end();
  }, { maxBytes: 1024, onOversize: (o) => over.push(o) });
  assert.equal(seen.length, 1);
  assert.equal(over.length, 0, 'мусор вне кадра — не переросшее сообщение');
});

test('сигнал 0x02 между кадрами не мешает: оба кадра приняты, по порядку', async () => {
  const seen = [];
  await withServer(async (t) => { seen.push(t); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    sock.write(Buffer.concat([Buffer.from([0x02, 0x02]), frame(MSG('41')), Buffer.from([0x02]), frame(MSG('42')), Buffer.from([0x02])]));
    await settle(250);
    sock.end();
  });
  assert.deepEqual(seen.map((t) => t.split('|')[9]), ['41', '42']);
});

test('attachMllpReader: читает кадры с любого сокета и называет байты вне кадра (onNoise)', async () => {
  const { attachMllpReader } = await import('./mllp.js');
  const noise = [];
  const seen = [];
  const accepted = [];
  const server = net.createServer((sock) => {
    accepted.push(sock);
    sock.on('error', () => {});
    attachMllpReader(sock, { onMessage: async (t, peer) => { seen.push({ t, peer }); return 'AA'; }, onNoise: (n) => noise.push(n), peer: 'прибор' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let sock = null;
  try {
    sock = await connect(server.address().port);
    const reply = readFrame(sock);
    sock.write(Buffer.concat([Buffer.from([0x02, 0x02, 0x02]), frame(MSG('51'))]));
    assert.match(await reply, /MSA\|AA\|51/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].peer, 'прибор');
    assert.deepEqual(noise, [3]);
  } finally {
    // Иначе server.close() ждал бы открытого соединения вечно.
    if (sock) sock.destroy();
    for (const s of accepted) s.destroy();
    await new Promise((r) => server.close(r));
  }
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R2, п. 10а ───────────────────────────────
// Прибор бросил кадр на середине и начал новый: раньше новый VT становился
// частью брошенного, и приём получал склейку двух сообщений (ответ — с номером
// брошенного). Теперь новый кадр начинается с нового VT, а брошенное начало
// уходит вызывающему (onAbandoned) — одной строкой лотка.
test('R2 п. 10а: новый VT до конца кадра — брошенное начало отдельно, новый кадр принят целиком', async () => {
  const seen = [];
  const cut = [];
  await withServer(async (t) => { seen.push(t); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(MSG('71') + '\rOBX|1|NM|WBC^^99MRC||6.', 'utf8'), frame(MSG('72'))]));
    assert.match(await reply, /MSA\|AA\|72/);
    sock.end();
  }, { onAbandoned: (o) => cut.push(o) });
  assert.deepEqual(seen, [MSG('72')]);
  assert.equal(cut.length, 1);
  assert.equal(cut[0].head, MSG('71') + '\rOBX|1|NM|WBC^^99MRC||6.');
  assert.ok(cut[0].peer);
});

// ── LIS_VENDOR_EXACT_V1 — D4: соединение прибора не рвётся простоем ─────────
// A1000 и BS-200 подключаются при запуске своей программы и могут молчать
// часами. A1000 после нашего FIN (end/destroy) не замечает закрытия: следующий
// результат уходит в мёртвое соединение и теряется, а до того его программа
// крутит ядро процессора (autobio-autolumo-a1000.settle.md, находка 6; RST —
// без этого). Поэтому: простоя нет, мёртвых убирает TCP keep-alive (30 с),
// закрываем — RST (resetAndDestroy), не FIN.

/** Что увидел прибор при закрытии: 'end' — FIN, код ошибки — RST (ECONNRESET). */
function trackClose(sock) {
  const ev = [];
  sock.on('data', () => {});
  sock.on('end', () => ev.push('end'));
  sock.on('error', (e) => ev.push(e.code));
  const closed = new Promise((r) => sock.once('close', r));
  return { ev, closed };
}

test('D4: соединению прибора при приёме — keep-alive 30 с и NoDelay; простоя (setTimeout) нет', async () => {
  const P = net.Socket.prototype;
  const orig = { setTimeout: P.setTimeout, setKeepAlive: P.setKeepAlive, setNoDelay: P.setNoDelay };
  const calls = [];
  for (const k of Object.keys(orig)) P[k] = function (...a) { calls.push({ sock: this, k, a }); return orig[k].apply(this, a); };
  try {
    await withServer(async () => 'AA', async (port) => {
      const sock = await connect(port);
      const reply = readFrame(sock);
      sock.write(frame(MSG('61')));
      await reply;
      // Серверная сторона этого соединения: её удалённый порт — наш локальный.
      const mine = calls.filter((c) => c.sock !== sock && c.sock.localPort === port && c.sock.remotePort === sock.localPort);
      const shown = JSON.stringify(mine.map((c) => [c.k, ...c.a.filter((x) => typeof x !== 'function')]));
      assert.ok(mine.some((c) => c.k === 'setKeepAlive' && c.a[0] === true && c.a[1] === 30000), 'keep-alive 30 с: ' + shown);
      assert.ok(mine.some((c) => c.k === 'setNoDelay' && c.a[0] !== false), 'NoDelay — ответы не склеиваются в один сегмент (A1000 M19): ' + shown);
      assert.ok(!mine.some((c) => c.k === 'setTimeout' && c.a[0] > 0), 'простоя нет: ' + shown);
      sock.end();
    });
  } finally {
    Object.assign(P, orig);
  }
});

test('D4: close() слушателя рвёт соединение прибора RST, а не FIN', async () => {
  const srv = await startMllpServer({ port: 0, onMessage: async () => 'AA' });
  const sock = await connect(srv.port);
  const { ev, closed } = trackClose(sock);
  const reply = readFrame(sock);
  sock.write(frame(MSG('62')));
  await reply;   // соединение принято и живо
  await srv.close();
  await closed;
  assert.ok(ev.includes('ECONNRESET'), 'RST: ' + ev.join(','));
  assert.ok(!ev.includes('end'), 'FIN не пришёл: ' + ev.join(','));
});

test('D4: переросшее — отказ дочитывается, потом RST, а не FIN', async () => {
  await withServer(async () => 'AA', async (port) => {
    const sock = await connect(port);
    const { ev, closed } = trackClose(sock);
    const reply = readFrame(sock);
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(MSG('81') + '\r' + 'D'.repeat(4096), 'utf8')]));
    assert.match(await reply, /MSA\|AE\|81\|/, 'отказ дошёл до прибора');
    await closed;
    assert.ok(ev.includes('ECONNRESET') && !ev.includes('end'), 'RST, а не FIN: ' + ev.join(','));
  }, { maxBytes: 1024, onOversize: () => {} });
});

// LIS_VENDOR_EXACT_V1 — D4, ревью: RST по сокету, у которого FIN уже в пути.
// Прибор прислал FIN — Node (allowHalfOpen = false) сам зовёт end(), и до конца
// shutdown libuv отвергает RST (uv_tcp_close_reset → EINVAL): Node выдаёт
// 'error', теряет дескриптор, не закрыв его, и 'close' не приходит никогда. Тогда
// слушатель вечно помнит соединение открытым (peers, экран), а звонок
// (dial.js), которого сторож тишины рвёт в этот миг, не поднимается заново — он
// ждёт 'close'. Здесь end() зовётся явно: то же состояние, без гонки.
test('D4: resetSocket сокета, у которого FIN уже в пути (end() вызван), — сокет закрывается: «close» приходит, EINVAL нет', async () => {
  const { resetSocket } = await import('./mllp.js');
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const accepted = new Promise((r) => server.once('connection', r));
  const peer = net.createConnection({ port: server.address().port, host: '127.0.0.1' });
  peer.on('error', () => {});
  const sock = await accepted;
  const ev = [];
  sock.on('error', (e) => ev.push('error:' + e.code));
  const closed = new Promise((r) => sock.once('close', () => r(true)));
  sock.end();          // FIN в пути: shutdown ещё не исполнен
  resetSocket(sock);   // тот же тик
  const ok = await Promise.race([closed, settle(2000).then(() => false)]);
  peer.destroy();
  server.close();
  assert.equal(ok, true, 'сокет закрылся (close): ' + ev.join(','));
  assert.deepEqual(ev, [], 'без ошибки EINVAL');
});

// LIS_VENDOR_EXACT_V1 — D4, ревью: тайм-аута простоя больше нет, а он был одним
// из двух пределов для того, кто не представился (порт неаутентифицирован).
// Новый предел — число открытых соединений с одного адреса: прибору нужно одно
// (A1000 держит его часами), переадресателю — по одному на анализатор его ПК.
// Сверх предела рвётся RST старейшее молчащее (кадров не было), иначе старейшее.
test('D4: с одного адреса — не больше MAX_SOCKETS_PER_IP открытых соединений; лишнее — старейшее молчащее, RST; живой прибор не тронут', async () => {
  const { MAX_SOCKETS_PER_IP } = await import('./mllp.js');
  assert.equal(MAX_SOCKETS_PER_IP, 16);
  const logs = [];
  const srv = await startMllpServer({ port: 0, onMessage: async () => 'AA', log: (m) => logs.push(m) });
  const all = [];
  try {
    // Первым подключился и прислал пробу настоящий прибор.
    const live = await connect(srv.port);
    all.push(live);
    const liveEv = trackClose(live);
    const reply = readFrame(live);
    live.write(frame(MSG('95')));
    await reply;
    // Потом тот же адрес открыл ещё MAX_SOCKETS_PER_IP молчащих.
    const silent = [];
    for (let i = 0; i < MAX_SOCKETS_PER_IP; i++) {
      const s = await connect(srv.port);
      all.push(s);
      silent.push({ s, localPort: s.localPort, ...trackClose(s) });   // порт — до закрытия: у закрытого его нет
    }
    await silent[0].closed;
    assert.ok(silent[0].ev.includes('ECONNRESET'), 'старейшее молчащее — RST: ' + silent[0].ev.join(','));
    await until(() => srv.peers().filter((p) => p.open).length === MAX_SOCKETS_PER_IP, 3000, 'открытых — ровно предел');
    assert.deepEqual(liveEv.ev, [], 'прибор, приславший пробу, на связи');
    assert.ok(srv.peers().some((p) => p.open && p.remotePort === live.localPort));
    assert.ok(logs.some((l) => /предел/.test(l) && l.includes('127.0.0.1:' + silent[0].localPort + ' ')), 'в журнал: ' + logs.filter((l) => /предел/.test(l)).join(' | '));
  } finally {
    for (const s of all) s.destroy();
    await srv.close();
  }
});

// ── LIS_VENDOR_EXACT_V1 — D10: текст кадра — UTF-8 строго, иначе windows-1251 ──
// BS-200 и CL-900i пишут однобайтно: «ISO 8859-1 characters (hexadecimal
// 20-FF)» (HIM v5.0, с. 1), на деле — кодовая страница ПК прибора (у клиники —
// кириллица, cp1251; mindray-bs-200.manual-check.md E6). Раньше всё читалось как
// UTF-8: «µmol/L» BS-240 приходило «�mol/L» (mindray-bs-240.md M3), кириллица —
// знаками U+FFFD.
const until = async (fn, ms = 3000, what = 'условие') => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(what + ' не наступило за ' + ms + ' мс');
    await settle(10);
  }
};

test('D10: кадр не в UTF-8 (windows-1251 / ISO 8859-1) читается как есть — кириллица ПК прибора, «µmol/L», без «�»', async () => {
  const seen = [];
  const bytes = Buffer.concat([
    Buffer.from([VT]),
    Buffer.from('MSH|^~\\&|Mindray|BS-200|||20261005101500||ORU^R01|71|P|2.3.1||||0||ASCII|||\rPID|1||||', 'latin1'),
    Buffer.from([0xC8, 0xE2, 0xE0, 0xED, 0xEE, 0xE2]),   // «Иванов» в windows-1251
    Buffer.from('\rOBR|1|LAB-000123|12|Mindray^BS-200|N\rOBX|1|NM|CREA|Creatinine|88.000000|', 'latin1'),
    Buffer.from([0xB5]),   // «µ»: одинаково в ISO 8859-1 и windows-1251
    Buffer.from('mol/L|-|N|||F\r', 'latin1'),
    Buffer.from([FS, CR]),
  ]);
  await withServer(async (t) => { seen.push(t); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(bytes);
    assert.match(await reply, /MSA\|AA\|71\|/);
    sock.end();
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /\rPID\|1\|\|\|\|Иванов\r/);
  assert.match(seen[0], /\|µmol\/L\|/);
  assert.ok(!seen[0].includes('\uFFFD'), 'ни одного U+FFFD');
});

test('D10: верный UTF-8 (BC-5300 пишет UTF-8, MSH-18 = UNICODE) — как прежде', async () => {
  const seen = [];
  const text = 'MSH|^~\\&|BC-5300|Mindray|||20080419104618||ORU^R01|72|P|2.3.1||||||UNICODE\rPID|1||TEST-0002^^^^MR||Иванов^Иван\rOBX|1|NM|6690-2^WBC^LN||4.63|10*9/L|||||F\r';
  await withServer(async (t) => { seen.push(t); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(frame(text));
    await reply;
    sock.end();
  });
  assert.equal(seen[0], text);
});

test('D10: decodeFrame — UTF-8 строго, иначе windows-1251; у начала переросшего обрезанный знак UTF-8 не превращает всё в windows-1251', async () => {
  const { decodeFrame } = await import('./mllp.js');
  assert.equal(decodeFrame(Buffer.from('MSH|Иванов µ', 'utf8')), 'MSH|Иванов µ');
  assert.equal(decodeFrame(Buffer.from([0x4d, 0xc8, 0xe2, 0xb5])), 'MИвµ', 'windows-1251');
  assert.equal(decodeFrame(Buffer.from('MSH|^~\\&|X', 'latin1')), 'MSH|^~\\&|X');
  const cut = Buffer.from('MSH|Иванов', 'utf8');
  assert.equal(decodeFrame(cut.subarray(0, cut.length - 1), { head: true }), 'MSH|Ивано', 'начало режется по 64 КБ — посреди знака');
});

test('D10: начало переросшего кадра в windows-1251 доходит до лотка читаемым', async () => {
  const over = [];
  await withServer(async () => 'AA', async (port) => {
    const sock = await connect(port);
    sock.on('error', () => {});
    const reply = readFrame(sock);
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(MSG('83') + '\rPID|1||||', 'latin1'), Buffer.from([0xC8, 0xE2, 0xE0, 0xED, 0xEE, 0xE2]), Buffer.alloc(4096, 0x51)]));
    await reply;
    sock.destroy();
  }, { maxBytes: 1024, onOversize: (o) => over.push(o) });
  assert.equal(over.length, 1);
  assert.match(over[0].head, /PID\|1\|\|\|\|ИвановQ/);
});

// ── LIS_VENDOR_EXACT_V1 — D14: байты не в кадре больше не пропадают молча ────
// Прибор, настроенный не на тот протокол (A1000 по умолчанию шлёт свой формат
// «{…}», ASTM — ENQ/STX, кодировка Unicode — UTF-16), раньше выглядел так же,
// как «никто не подключался» (mllp.js, байты до VT выбрасывались без следа).
// Теперь: подключение — в журнал с адресом и портом; байты не в кадре — в
// журнал с подсказкой протокола; по соединению — состояние для экрана
// (srv.peers(), index.js listenerStatus().peers). Пачки — раскладка
// производителя с синтетическими значениями (capture-kit\tests\run-tests.ps1:
// ASTM_AB_1, AUTOBIO_NATIVE, UTF16, HL7_NO_MLLP, BINARY).
const astmFrame = (fnText, term) => {
  const body = Buffer.concat([Buffer.from(fnText, 'latin1'), Buffer.from([term])]);
  let sum = 0;
  for (const x of body) sum += x;
  return Buffer.concat([Buffer.from([0x02]), body, Buffer.from((sum % 256).toString(16).toUpperCase().padStart(2, '0') + '\r\n', 'latin1')]);
};
const ASTM_AB_1 = astmFrame('1H|\\^&|||AutoLumo A1000||0|||||REQ5|1394-97|20261005120000\rP|1||TEST\rO|1||^LAB-000123^R01^3|432^107^||\r', 0x17);
const AUTOBIO_NATIVE = Buffer.from('{5,0,[S]LAB-000123,107,41765L,4.17F}', 'latin1');
const HL7_NO_MLLP = Buffer.from('MSH|^~\\&|||||20261005120000||ORU^R01|41|P|2.3.1\rPID|1\r', 'latin1');

test('D14: noiseHint — на что похожи байты не в кадре: ASTM, Autobio, UTF-16, HL7 без рамки, сигнал 0x02, прочее', async () => {
  const { noiseHint } = await import('./mllp.js');
  assert.equal(noiseHint(Buffer.from([0x05])), 'astm', 'ENQ');
  assert.equal(noiseHint(Buffer.from([0x04])), 'astm', 'EOT');
  assert.equal(noiseHint(ASTM_AB_1), 'astm', 'кадр ASTM A1000 (STX, номер кадра, ETB)');
  assert.equal(noiseHint(AUTOBIO_NATIVE), 'autobio', 'родной формат Autobio');
  assert.equal(noiseHint(Buffer.from('MSH|^~\\&|Mindray|BS-200|||20261005101500||ORU^R01|51|P|2.3.1||||0||ASCII|||\r', 'utf16le')), 'utf16');
  assert.equal(noiseHint(HL7_NO_MLLP), 'hl7-unframed');
  assert.equal(noiseHint(Buffer.from([0x02])), 'heartbeat', 'сигнал гематологии Mindray');
  assert.equal(noiseHint(Buffer.from([0x02, 0x02, 0x02])), 'heartbeat');
  assert.equal(noiseHint(Buffer.from([0xff, 0xfe, 0x10, 0x20, 0x80, 0x81, 0x7f, 0x01])), 'other');
  assert.equal(noiseHint(Buffer.from('\r\n', 'latin1')), null, 'концы строк — не шум');
});

test('D14: подключение — в журнал с адресом и портом; байты не в кадре — с подсказкой протокола, не чаще раза в минуту на вид', async () => {
  const logs = [];
  const srv = await startMllpServer({ port: 0, onMessage: async () => 'AA', log: (m) => logs.push(m) });
  const sock = await connect(srv.port);
  sock.on('error', () => {});
  try {
    const label = '127.0.0.1:' + sock.localPort;
    await until(() => logs.some((l) => l.includes(label)), 3000, 'строка о подключении');
    for (const b of [Buffer.from([0x05]), Buffer.from([0x05]), AUTOBIO_NATIVE]) { sock.write(b); await settle(60); }
    await until(() => logs.some((l) => /Autobio/.test(l)), 3000, 'строка о формате Autobio');
    const noise = logs.filter((l) => l.includes(label) && /не в кадре/.test(l));
    assert.equal(noise.filter((l) => /ASTM/.test(l)).length, 1, 'два ENQ подряд — одна строка: ' + noise.join(' | '));
    assert.equal(noise.filter((l) => /Autobio/.test(l)).length, 1);
  } finally {
    sock.destroy();
    await srv.close();
  }
  await until(() => logs.some((l) => /закрыто/.test(l)), 3000, 'закрытие — тоже в журнал');
});

test('D14: srv.peers() — по соединению ip, port (порт приёма), connectedAt, lastRxAt, frames, noiseBytes, noiseHint, open; сигнал 0x02 — не «непонятные данные»', async () => {
  const srv = await startMllpServer({ port: 0, onMessage: async () => 'AA' });
  try {
    const a = await connect(srv.port);
    const reply = readFrame(a);
    a.write(Buffer.concat([Buffer.from([0x05]), frame(MSG('91'))]));
    await reply;
    const b = await connect(srv.port);
    b.write(Buffer.from([0x02, 0x02]));
    await until(() => (srv.peers() || []).some((p) => p.remotePort === b.localPort && p.lastRxAt), 3000, 'сигнал дошёл');
    const aPort = a.localPort;
    const pa = srv.peers().find((p) => p.remotePort === aPort);
    const pb = srv.peers().find((p) => p.remotePort === b.localPort);
    for (const k of ['ip', 'port', 'connectedAt', 'lastRxAt', 'frames', 'noiseBytes', 'noiseHint', 'open']) assert.ok(k in pa, k);
    assert.deepEqual([pa.ip, pa.port, pa.frames, pa.noiseBytes, pa.noiseHint, pa.open], ['127.0.0.1', srv.port, 1, 1, 'astm', true]);
    assert.match(pa.connectedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.match(pa.lastRxAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual([pb.frames, pb.noiseBytes, pb.noiseHint, pb.open], [0, 0, null, true], 'экран скажет «ждёт первую пробу», а не «непонятные данные»');
    a.destroy();
    await until(() => srv.peers().find((p) => p.remotePort === aPort).open === false, 3000, 'закрытое — open: false');
    b.destroy();
  } finally {
    await srv.close();
  }
});

test('D14: srv.peers() помнит последние ~50 соединений; открытые — все', async () => {
  const srv = await startMllpServer({ port: 0, onMessage: async () => 'AA' });
  try {
    const keep = await connect(srv.port);
    for (let i = 0; i < 55; i++) {
      const s = await connect(srv.port);
      const gone = new Promise((r) => s.once('close', r));
      s.destroy();
      await gone;
    }
    await until(() => srv.peers().filter((p) => p.open).length === 1, 3000, 'закрытые помечены');
    const peers = srv.peers();
    assert.equal(peers.length, 50);
    assert.ok(peers.some((p) => p.open && p.remotePort === keep.localPort), 'открытое не вытеснено');
    keep.destroy();
  } finally {
    await srv.close();
  }
});
