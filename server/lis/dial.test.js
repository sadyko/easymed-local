// dial.test.js — LIS_REAL_ANALYZERS_V1_DIAL: Easy-Med подключается к прибору сам
// (docs/specs/2026-10-01-lis-real-analyzers-design.md, раздел 8).
//
// Прибор-сервер (Mindray BC-3600, BC-5800; возможно, BC-780) ждёт звонка LIS
// на своём порту, шлёт сигнал 0x02 раз в 3 с и кадры MLLP. Здесь он поддельный:
// TCP-сервер на 127.0.0.1 с портом 0 (как в mllp.test.js: сырой net на обеих
// сторонах — ограничение fetch про «плохие» порты не действует). Время повтора
// сжато через timing, чтобы тест шёл миллисекунды, а не минуты.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startMllpClient, isLocalIp, DIAL_DEFAULTS } from './dial.js';
import { VT, FS, CR } from './mllp.js';

const frame = (s) => Buffer.concat([Buffer.from([VT]), Buffer.from(s, 'utf8'), Buffer.from([FS, CR])]);
const ORU = (id) => `MSH|^~\\&|BC-780|Mindray|||20261001090000||ORU^R01|${id}|P|2.3.1||||||UNICODE\rOBR|1||LAB-000123|00001^Automated Count^99MRC\rOBX|1|NM|6690-2^WBC^LN||7.25|10*9/L|4.0-10.0|N|||F`;
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ждёт, пока условие станет верным (не дольше ms). */
async function until(fn, ms = 3000, what = 'условие') {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(what + ' не наступило за ' + ms + ' мс');
    await settle(10);
  }
}

/**
 * Поддельный анализатор-сервер. conns — все принятые соединения по порядку;
 * acks — ответы Easy-Med (текст кадра), пришедшие в любое соединение.
 */
async function fakeAnalyzer({ port = 0 } = {}) {
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
  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', res); });
  return {
    port: server.address().port,
    conns,
    acks,
    live: () => conns.filter((c) => !c.destroyed),
    async close() {
      for (const c of conns) c.destroy();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

const FAST = { minBackoffMs: 40, maxBackoffMs: 320, jitter: 0, connectTimeoutMs: 1000, stableMs: 60000, silenceMs: 20000 };

test('пауза по умолчанию — по спецификации: 2 с → 60 с, ±20 %, ожидание 10 с, сигнал 20 с', () => {
  assert.deepEqual({ ...DIAL_DEFAULTS }, {
    minBackoffMs: 2000, maxBackoffMs: 60000, jitter: 0.2, connectTimeoutMs: 10000, stableMs: 60000, silenceMs: 20000, keepAliveMs: 30000,
  });
});

test('кадры приходят — ответ ACK^R01 тем же проводом, что у сервера', async () => {
  const fake = await fakeAnalyzer();
  const seen = [];
  const client = startMllpClient({ host: '127.0.0.1', port: fake.port, timing: FAST, onMessage: async (text, peer) => { seen.push({ text, peer }); return 'AA'; } });
  try {
    await until(() => fake.live().length === 1, 3000, 'подключение');
    await until(() => client.status().state === 'connected', 3000, 'состояние connected');
    assert.equal(client.status().code, null);
    fake.live()[0].write(frame(ORU('5')));
    await until(() => fake.acks.length === 1, 3000, 'ответ');
    const [msh, msa] = fake.acks[0].split('\r');
    assert.equal(msh.split('|')[8], 'ACK^R01');
    assert.equal(msa, 'MSA|AA|5|Message accepted|||0');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].peer, '127.0.0.1', 'peer — адрес прибора');
    assert.ok(client.status().last_rx_at, 'время последнего байта от прибора');
  } finally {
    client.close();
    await fake.close();
  }
});

test('сигнал 0x02 каждые 100 мс не мешает и не копится: кадр после сотен байт сигнала принимается', async () => {
  const fake = await fakeAnalyzer();
  const seen = [];
  // Потолок кадра 256 байт: копи читатель сигнал, он перерос бы потолок и
  // отказал бы кадру (AE), а не принял его.
  const client = startMllpClient({ host: '127.0.0.1', port: fake.port, timing: FAST, maxBytes: 512, onMessage: async (t) => { seen.push(t); return 'AA'; } });
  let beat;
  try {
    await until(() => fake.live().length === 1, 3000, 'подключение');
    const sock = fake.live()[0];
    beat = setInterval(() => { if (!sock.destroyed) sock.write(Buffer.alloc(100, 0x02)); }, 100);
    await settle(700);
    const before = client.status().last_rx_at;
    assert.ok(before, 'сигнал — тоже байты от прибора: «сигнал N с назад»');
    sock.write(frame(ORU('6')));
    await until(() => fake.acks.length === 1, 3000, 'ответ после сигнала');
    assert.match(fake.acks[0], /MSA\|AA\|6\|/);
    assert.equal(seen.length, 1);
    assert.equal(fake.conns.length, 1, 'одно соединение, без переподключений');
  } finally {
    clearInterval(beat);
    client.close();
    await fake.close();
  }
});

test('прибор погас — клиент подключается снова с растущей паузой; пауза сбрасывается после кадра', async () => {
  const fake = await fakeAnalyzer();
  const port = fake.port;
  const waits = [];
  const client = startMllpClient({ host: '127.0.0.1', port, timing: FAST, onMessage: async () => 'AA', onWait: (ms, code) => waits.push([ms, code]) });
  let again = null;
  try {
    await until(() => fake.live().length === 1, 3000, 'подключение');
    await fake.close();   // прибор выключили: соединение оборвано, порт закрыт
    await until(() => waits.length >= 5, 5000, 'пять повторов');
    assert.deepEqual(waits.slice(0, 5).map(([ms]) => ms), [40, 80, 160, 320, 320], 'удвоение до потолка');
    assert.equal(waits[0][1], 'closed', 'сначала — соединение закрыто прибором');
    assert.equal(waits[1][1], 'refused', 'потом — порт прибора закрыт');
    assert.equal(client.status().state === 'waiting' || client.status().state === 'connecting', true);
    assert.ok(client.status().state !== 'waiting' || client.status().retry_at, 'у ожидания есть время повтора');

    again = await fakeAnalyzer({ port });   // прибор включили
    await until(() => again.live().length === 1, 3000, 'переподключение');
    await until(() => client.status().state === 'connected', 3000, 'connected');
    again.live()[0].write(frame(ORU('7')));
    await until(() => again.acks.length === 1, 3000, 'ответ');
    const n = waits.length;
    await again.close();
    await until(() => waits.length > n, 3000, 'повтор после кадра');
    assert.equal(waits[n][0], 40, 'соединение принесло кадр — пауза снова 2 с (здесь 40 мс)');
  } finally {
    client.close();
    if (again) await again.close().catch(() => {});
  }
});

test('close() возвращается сразу (меньше 100 мс) при открытом соединении и рвёт его', async () => {
  const fake = await fakeAnalyzer();
  const client = startMllpClient({ host: '127.0.0.1', port: fake.port, timing: FAST, onMessage: async () => 'AA' });
  try {
    await until(() => fake.live().length === 1, 3000, 'подключение');
    const sock = fake.live()[0];
    const dropped = new Promise((r) => sock.once('close', r));
    const t = performance.now();
    const ret = client.close();
    assert.ok(performance.now() - t < 100, 'close() не ждёт прибора: урок lis_restart / lis_device_delete');
    assert.equal(ret, undefined, 'ничего не ждёт — и обещания нет');
    await Promise.race([dropped, settle(2000).then(() => { throw new Error('соединение не порвано'); })]);
    await settle(200);
    assert.equal(fake.conns.length, 1, 'после close() — ни одного нового подключения');
    assert.equal(client.status().state, 'closed');
  } finally {
    client.close();
    await fake.close();
  }
});

test('прибор слал сигнал и замолчал — соединение мёртвое: рвётся и поднимается снова', async () => {
  const fake = await fakeAnalyzer();
  const waits = [];
  const client = startMllpClient({ host: '127.0.0.1', port: fake.port, timing: { ...FAST, silenceMs: 300 }, onMessage: async () => 'AA', onWait: (ms, code) => waits.push(code) });
  try {
    await until(() => fake.live().length === 1, 3000, 'подключение');
    fake.live()[0].write(Buffer.from([0x02]));   // сигнал — и тишина, сокет открыт
    await until(() => fake.conns.length === 2, 3000, 'переподключение после тишины');
    assert.equal(waits[0], 'silent');
    assert.ok(fake.conns[0].destroyed || fake.conns[0].readableEnded, 'мёртвое соединение закрыто');
  } finally {
    client.close();
    await fake.close();
  }
});

test('прибор без сигнала может молчать часами — простоя у клиента нет', async () => {
  const fake = await fakeAnalyzer();
  const client = startMllpClient({ host: '127.0.0.1', port: fake.port, timing: { ...FAST, silenceMs: 150 }, onMessage: async () => 'AA' });
  try {
    await until(() => fake.live().length === 1, 3000, 'подключение');
    fake.live()[0].write(frame(ORU('8')));
    await until(() => fake.acks.length === 1, 3000, 'ответ');
    await settle(500);
    assert.equal(fake.conns.length, 1, 'кадр — не сигнал: без 0x02 соединение не считается мёртвым');
    assert.equal(client.status().state, 'connected');
  } finally {
    client.close();
    await fake.close();
  }
});

test('isLocalIp: только IP-адрес локальной сети — без имён (DNS — лишнее соединение)', () => {
  for (const ok of ['10.0.0.30', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.20', '169.254.10.1', '127.0.0.1', '127.8.8.8',
    '::1', 'fc00::1', 'fd12:3456::7', 'fe80::1', 'febf::1', '::ffff:10.0.0.9', '::ffff:192.168.0.5']) {
    assert.equal(isLocalIp(ok), true, ok);
  }
  for (const bad of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '169.255.0.1', '1.1.1.1', '2001:db8::1', 'fec0::1', '::ffff:8.8.8.8',
    'localhost', 'analyzer.local', 'bc780', '', null, undefined, '10.0.0.256', '10.0.0', '0.0.0.0', '::']) {
    assert.equal(isLocalIp(bad), false, String(bad));
  }
});
