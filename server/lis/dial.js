// LIS_REAL_ANALYZERS_V1_DIAL — Easy-Med подключается к прибору сам
// (docs/specs/2026-10-01-lis-real-analyzers-design.md, раздел 8).
//
// Зачем. Роль TCP у BC-780 неизвестна: у BC-6800 и BC-5390 она переключается,
// а старые BC-3600 и BC-5800 — только сервер: LIS подключается к прибору
// (BC5800.cs, строки 51–66: TcpClient.BeginConnect, повтор по таймеру;
// geulis docs/BC-3600.md: порт 3600, «heartbeat control code 0x02 once in 3
// seconds»). Такой прибор сам не звонит, и без этого клиента его не подключить.
//
// Тот же читатель кадров и тот же ответ, что у сервера (mllp.js
// attachMllpReader): последовательная цепочка ответов, потолок 4 МБ, AE на
// переросшее, ответ после записи. Отличия клиента:
//   — повтор подключения с паузой 2 с, 4, 8, … до 60 с, разброс ±20 %; пауза
//     сбрасывается к 2 с после соединения, которое принесло кадр или
//     продержалось 60 с; ожидание подключения — 10 с;
//   — простоя нет: прибор может молчать часами; setKeepAlive(true, 30 с);
//   — сигнал прибора (байты вне кадра, 0x02 у BC-3600) отвечать не нужно
//     («no acknowledgment is required»), читатель его отбрасывает; но если
//     прибор слал сигнал и замолчал на 20 с — соединение мёртвое: рвётся и
//     поднимается заново;
//   — close() снимает таймер, рвёт сокет и возвращается сразу, ничего не
//     ожидая: урок lis_restart / lis_device_delete (LIS_DISCOVERY_FIX_V1) —
//     закрытие, ждущее прибора, вешало RPC.
//
// Безопасность: исходящее соединение — только на адрес и порт строки прибора
// (проверку адреса делает index.js по isLocalIp), одно на прибор. Прибору
// уходят только ответы приёма (ACK, «заказов нет»), больше ничего.
import net from 'node:net';
import { attachMllpReader, DEFAULT_MAX_BYTES } from './mllp.js';

export const DIAL_DEFAULTS = Object.freeze({
  minBackoffMs: 2000,       // первая пауза
  maxBackoffMs: 60000,      // потолок паузы
  jitter: 0.2,              // разброс ±20 %
  connectTimeoutMs: 10000,  // ожидание подключения
  stableMs: 60000,          // соединение, продержавшееся столько, сбрасывает паузу
  silenceMs: 20000,         // прибор слал сигнал и замолчал — соединение мёртвое
  keepAliveMs: 30000,       // TCP keep-alive
});

// ── Адрес: только IP локальной сети ─────────────────────────────────────────
// Имя (bc780.local) — это обращение к DNS, лишнее соединение наружу, поэтому
// имена не принимаются вовсе. Анализатор в интернете означает ошибку в адресе.

function ipv4Local(a) {
  const p = a.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  return p[0] === 10                                   // 10/8
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)      // 172.16/12
    || (p[0] === 192 && p[1] === 168)                  // 192.168/16
    || (p[0] === 169 && p[1] === 254)                  // 169.254/16
    || p[0] === 127;                                   // 127/8
}

/**
 * IP-адрес локальной сети: 10/8, 172.16/12, 192.168/16, 169.254/16, 127/8;
 * IPv6 fc00::/7, fe80::/10, ::1; IPv4 внутри IPv6 (::ffff:10.0.0.9) — по
 * правилам IPv4. Имя, пустое, «0.0.0.0», «::» и прочее — нет.
 */
export function isLocalIp(host) {
  const h = String(host == null ? '' : host).trim();
  const kind = net.isIP(h);
  if (kind === 4) return ipv4Local(h);
  if (kind !== 6) return false;
  const lower = h.toLowerCase().split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4Local(mapped[1]);
  if (lower === '::1') return true;
  const first = lower.startsWith('::') ? 0 : parseInt(lower.split(':')[0], 16);
  if (!Number.isFinite(first)) return false;
  return (first & 0xfe00) === 0xfc00     // fc00::/7
    || (first & 0xffc0) === 0xfe80;      // fe80::/10
}

/** Причина обрыва или отказа — кодом; слова подбирает экран (E9). */
function codeOf(err) {
  switch (err && err.code) {
    case 'ECONNREFUSED': return 'refused';
    case 'ETIMEDOUT': return 'timeout';
    case 'EHOSTUNREACH': case 'ENETUNREACH': case 'EHOSTDOWN': case 'ENETDOWN': case 'EADDRNOTAVAIL': return 'unreachable';
    case 'ECONNRESET': case 'EPIPE': case 'ECONNABORTED': return 'closed';
    default: return 'error';
  }
}

const iso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Клиент MLLP: держит одно соединение с прибором и поднимает его снова.
 *
 * @param {object} o
 * @param {string} o.host   IP прибора (index.js уже проверил isLocalIp)
 * @param {number} o.port   порт прибора
 * @param {(text:string, peer:string)=>Promise<any>} o.onMessage  тот же договор, что у startMllpServer
 * @param {(o:object)=>void} [o.onOversize]
 * @param {number} [o.maxBytes]
 * @param {(msg:string)=>void} [o.log]
 * @param {Partial<typeof DIAL_DEFAULTS>} [o.timing]  для тестов: сжатое время
 * @param {(ms:number, code:string)=>void} [o.onWait]  перед каждой паузой: длина и причина
 * @returns {{close:()=>void, status:()=>{host:string, port:number, state:string, since:string, last_rx_at:string|null, code:string|null, retry_at:string|null}}}
 *   state: 'connecting' | 'connected' | 'waiting' | 'closed';
 *   code (у waiting): 'refused' — порт прибора закрыт, 'timeout' — нет ответа,
 *   'unreachable' — адрес недоступен, 'closed' — соединение закрыл прибор,
 *   'silent' — прибор слал сигнал и замолчал, 'error' — прочее.
 */
export function startMllpClient({ host, port, onMessage, onOversize = null, maxBytes = DEFAULT_MAX_BYTES, log = () => {}, timing = {}, onWait = null }) {
  const T = { ...DIAL_DEFAULTS, ...timing };
  const st = { host, port, state: 'connecting', since: iso(), last_rx_at: null, code: null, retry_at: null };
  let closed = false;
  let sock = null;
  let timer = null;
  let backoff = T.minBackoffMs;

  function wait(code) {
    const base = backoff;
    backoff = Math.min(backoff * 2, T.maxBackoffMs);
    const spread = T.jitter ? 1 + (Math.random() * 2 - 1) * T.jitter : 1;
    const delay = Math.max(0, Math.round(base * spread));
    Object.assign(st, { state: 'waiting', since: iso(), code, retry_at: iso(Date.now() + delay) });
    if (onWait) { try { onWait(delay, code); } catch { /* наблюдатель не мешает повтору */ } }
    timer = setTimeout(() => { timer = null; connect(); }, delay);
    if (timer.unref) timer.unref();
  }

  function connect() {
    if (closed) return;
    Object.assign(st, { state: 'connecting', since: iso(), retry_at: null });
    const s = net.createConnection({ host, port });
    sock = s;
    // Как server.unref() у слушателя: клиент анализатора не держит процесс
    // живым — его и так держит HTTP-сервер, а тесты не должны ждать вечно.
    s.unref();
    let connectedAt = 0;
    let gotFrame = false;
    let sawSignal = false;
    let reason = '';

    const connectTimer = setTimeout(() => { reason = 'timeout'; s.destroy(); }, T.connectTimeoutMs);
    if (connectTimer.unref) connectTimer.unref();

    s.once('connect', () => {
      clearTimeout(connectTimer);
      connectedAt = Date.now();
      Object.assign(st, { state: 'connected', since: iso(connectedAt), code: null, retry_at: null });
      s.setKeepAlive(true, T.keepAliveMs);
      s.setNoDelay(true);
      log(`LIS: подключено к прибору ${host}:${port}`);
    });
    s.on('data', () => { st.last_rx_at = iso(); });
    attachMllpReader(s, {
      peer: host,
      maxBytes,
      log,
      onOversize,
      onMessage: (text, peer) => { gotFrame = true; return onMessage(text, peer); },
      // Сигнал прибора — байты вне кадра. С первого сигнала прибор обязан
      // говорить хоть что-то: 20 с тишины — соединение мёртвое (кабель, свитч,
      // прибор перезагрузился без FIN), рвём и поднимаем заново. Прибор без
      // сигнала может молчать часами — у него такого сторожа нет.
      onNoise: () => {
        if (sawSignal) return;
        sawSignal = true;
        s.setTimeout(T.silenceMs, () => { reason = 'silent'; s.destroy(); });
      },
    });
    s.on('error', (e) => { if (!reason) reason = codeOf(e); });
    s.on('close', () => {
      clearTimeout(connectTimer);
      if (sock === s) sock = null;
      if (closed) return;
      if (connectedAt) log(`LIS: соединение с прибором ${host}:${port} закрыто`);
      if (gotFrame || (connectedAt && Date.now() - connectedAt >= T.stableMs)) backoff = T.minBackoffMs;
      wait(reason || (connectedAt ? 'closed' : 'error'));
    });
  }

  connect();

  return {
    close() {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (sock) { sock.destroy(); sock = null; }
      Object.assign(st, { state: 'closed', since: iso(), retry_at: null });
    },
    status() { return { ...st }; },
  };
}
