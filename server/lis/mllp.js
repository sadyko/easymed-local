// LIS_INGEST_V1 — MLLP: кадрирование HL7 поверх TCP.
//
// Кадр: 0x0B <текст> 0x1C 0x0D. Прибор может прислать кадр кусками, может
// прислать два кадра в одной записи, и обязан получить ответ прежде, чем
// пошлёт следующий.
//
// Порт неаутентифицирован — анализаторы не умеют логиниться (спецификация,
// «Безопасность»). Отсюда потолок размера: им ограничен тот, кто не
// представился.
// LIS_VENDOR_EXACT_V1 — тайм-аута простоя больше нет (D4): A1000 и BS-200
// подключаются при запуске своей программы и молчат часами, а A1000 после
// нашего закрытия (FIN) обрыва не замечает — следующий результат уходит в
// мёртвое соединение и теряется, а до того его программа крутит ядро
// процессора (analyzer-research, autobio-autolumo-a1000.settle.md, находка 6).
// Мёртвые соединения убирает TCP keep-alive (30 с); закрываем сами — RST
// (resetSocket), не FIN.
import net from 'node:net';
import { buildAck, mshOf } from './hl7.js';   // mshOf: LIS_REAL_ANALYZERS_V1_ACK
import { internalAck } from './hl7.js';   // LIS_VENDOR_EXACT_V1 — отказ по нашей вине в виде прибора

export const VT = 0x0b;
export const FS = 0x1c;
export const CR = 0x0d;

// LIS_MINDRAY_CODES_V1 (ревью 2026-09-28) — потолок 4 МБ, а не 256 КБ.
// Настоящий Mindray кладёт в пробу картинки: гистограммы и скаттерграммы BMP в
// base64 (строки ED). Такое сообщение легко больше 256 КБ, и тогда результаты
// не приходили вовсе — соединение рвалось молча. 4 МБ — с запасом на тяжёлые
// пробы и всё ещё предел для того, кто не представился.
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
// LIS_VENDOR_EXACT_V1 — D4: вместо простоя в 5 минут — TCP keep-alive, как у
// звонка (dial.js DIAL_DEFAULTS.keepAliveMs): живой молчащий прибор держит
// соединение сколько угодно, мёртвое (кабель, выключенный ПК без FIN/RST)
// закрывает сама система.
export const KEEPALIVE_MS = 30000;
// Сколько начала переросшего сообщения отдать вызывающему (в лоток): MSH, PID,
// OBR и числа идут первыми, картинки — в конце. 64 КБ хватает, чтобы узнать
// пробу, и не превращают лоток в склад картинок.
const HEAD_BYTES = 64 * 1024;
// После отказа прибору дают дочитать ответ, прежде чем оборвать соединение:
// тот, кто продолжает слать, не держит его дольше этого.
const OVERSIZE_GRACE_MS = 2000;

/**
 * LIS_VENDOR_EXACT_V1 — D4: закрыть соединение прибора RST (resetAndDestroy), а
 * не FIN. После FIN программа A1000 считает себя на связи, шлёт следующий
 * результат в мёртвое соединение и теряет его, а до того крутит ядро
 * процессора; после RST она сразу видит обрыв и переподключается
 * (autobio-autolumo-a1000.settle.md, находка 6). Соединение, которое ещё
 * подключается, просто уничтожается: ему нечего обрывать. Не бросает.
 * @param {import('node:net').Socket|null} sock
 */
export function resetSocket(sock) {
  if (!sock || sock.destroyed) return;
  try {
    if (sock.connecting) sock.destroy();
    else sock.resetAndDestroy();
  } catch {
    sock.destroy();
  }
}

// LIS_VENDOR_EXACT_V1 — CR после последнего сегмента ставит сам ответ (hl7.js
// buildAck, buildQueryReply), поэтому кадр кончается «…<CR><FS><CR>», как у
// производителя (HIM v5.0, с. 25); готовый ответ приёма ({ reply }) уходит как есть.
const frameOf = (text) => Buffer.concat([Buffer.from([VT]), Buffer.from(text, 'utf8'), Buffer.from([FS, CR])]);

// LIS_REAL_ANALYZERS_V1_ACK — заголовок входящего читает mshOf (hl7.js) без
// исключений, вместо прежнего controlIdOf: ответить надо и на то, что разобрать
// не удалось, иначе прибор не поймёт, на что пришёл отказ. Ответ — buildAck с
// эхом заголовка; сорвавшийся приём и переросшее — AE 207 (ACK_INTERNAL), а не
// «ошибка разбора» 100: сообщение могло быть верным.
// LIS_VENDOR_EXACT_V1 — и в виде прибора: replyStyle(msh) вызывающего (index.js
// → receive.js replyStyle) называет вид и провод; у химии Mindray отказ — AR 207
// (hl7.js internalAck). Без replyStyle — вид руководства, как незнакомому.

/** Байты вне кадра, кроме концов строк: CR после FS может прийти отдельной записью. */
function noiseBytes(buf, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) if (buf[i] !== CR && buf[i] !== 0x0a) n++;
  return n;
}

/**
 * LIS_VENDOR_EXACT_V1 — D10: текст кадра. Строго UTF-8 (TextDecoder с fatal), а
 * если байты — не UTF-8, то windows-1251: BS-200 и CL-900i пишут однобайтно
 * («ISO 8859-1 characters (hexadecimal 20-FF)», HIM v5.0, с. 1), на деле — в
 * кодовой странице ПК прибора, у клиники — кириллической; «µ» (0xB5) в
 * ISO 8859-1 и windows-1251 одинаков. Раньше всё читалось как UTF-8, и такие
 * байты становились «�» (U+FFFD): «µmol/L» BS-240 — «�mol/L».
 * o.head — начало переросшего или брошенного кадра (первые 64 КБ): последний
 * знак UTF-8 там может быть обрезан, и это не повод читать всё как windows-1251.
 * Сборка Node — с полным ICU (проверено на runtime\node.exe клиники, 24.14.0).
 * @param {Uint8Array} bytes
 * @param {{head?:boolean}} [o]
 */
export function decodeFrame(bytes, { head = false } = {}) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, head ? { stream: true } : undefined);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

/**
 * LIS_VENDOR_EXACT_V1 — D14: на что похожи байты вне кадра MLLP. Код — для
 * экрана (index.js listenerStatus().peers[].noiseHint; слова подбирает
 * lab-devices-lists.js) и журнала:
 *   'heartbeat'    — только 0x02: сигнал гематологии Mindray раз в 3 с
 *                    (BC-3600 OM p. D-8; mindray-bc-20.md §1.4) — не беда;
 *   'utf16'        — каждый второй байт 0x00: прибору выбрана кодировка
 *                    Unicode (UTF-16) — нужна UTF-8 или ASCII;
 *   'astm'         — ENQ 0x05, EOT 0x04 или кадр STX + номер 0–7 (E1381):
 *                    прибор настроен на ASTM, а Easy-Med принимает HL7;
 *   'autobio'      — «{cmd,err,…}»: собственный формат Autobio (у A1000 он по
 *                    умолчанию, autobio-autolumo-a1000.md §2);
 *   'hl7-unframed' — текст HL7 («MSH|») без рамки 0x0B … 0x1C 0x0D;
 *   'other'        — прочее; null — одни концы строк.
 * @param {Uint8Array} bytes
 * @returns {string|null}
 */
export function noiseHint(bytes) {
  const b = Buffer.from(bytes || []);
  let n = 0;
  let nul = 0;
  let stx = 0;
  for (const x of b) {
    if (x === CR || x === 0x0a) continue;
    n++;
    if (x === 0x00) nul++;
    if (x === 0x02) stx++;
  }
  if (!n) return null;
  if (n >= 2 && nul * 3 >= b.length) return 'utf16';
  if (stx === n) return 'heartbeat';
  const text = b.toString('latin1');
  if (b.includes(0x05) || b.includes(0x04) || /\x02[0-7]/.test(text)) return 'astm';
  if (/^[\s]*\{/.test(text)) return 'autobio';
  if (text.includes('MSH|')) return 'hl7-unframed';
  return 'other';
}

/** LIS_VENDOR_EXACT_V1 — D14: подсказка для журнала. */
const HINT_TEXT = {
  utf16: 'похоже на текст в кодировке Unicode (UTF-16) — на анализаторе выберите кодировку UTF-8 или ASCII',
  astm: 'похоже на ASTM (ENQ/STX) — Easy-Med принимает HL7: на анализаторе выберите протокол HL7',
  autobio: 'похоже на собственный формат Autobio «{…}» — на анализаторе выберите протокол HL7',
  'hl7-unframed': 'похоже на HL7 без рамки MLLP (нет байта 0x0B) — на анализаторе включите MLLP',
  other: 'протокол не узнан — на анализаторе проверьте протокол HL7',
};
/** LIS_VENDOR_EXACT_V1 — D14: одна строка журнала на вид и соединение — не чаще раза в минуту (ENQ повторяется каждые несколько секунд). */
const NOISE_LOG_MS = 60 * 1000;

/** LIS_VENDOR_EXACT_V1 — D14: время для экрана — как у звонка (dial.js): ISO без миллисекунд. */
const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
/** LIS_VENDOR_EXACT_V1 — D14: сколько последних соединений помнит слушатель (открытые — все). */
export const PEERS_KEPT = 50;

/**
 * LIS_REAL_ANALYZERS_V1_DIAL — читатель кадров одного соединения: общий для
 * сервера (каждое входящее соединение, startMllpServer) и клиента, который
 * звонит прибору сам (dial.js). Разбор кадров, последовательная цепочка
 * ответов, потолок, AE на переросшее и ответ после записи — одни на оба.
 *
 * Байты вне кадра (сигнал 0x02 у Mindray BC-3600 раз в 3 с) отбрасываются
 * сразу, до первого VT, а не копятся до потолка: раньше прибор с сигналом за
 * сутки дорастал бы до отказа «больше 4 МБ» без единого настоящего кадра.
 *
 * @param {import('node:net').Socket} sock
 * @param {object} o
 * @param {(text:string, peer:string)=>Promise<any>} o.onMessage  как у startMllpServer
 * @param {(o:{peer:string, bytes:number, head:string, limit:number})=>void} [o.onOversize]
 * @param {number} [o.maxBytes]
 * @param {(msg:string)=>void} [o.log]
 * @param {string} [o.peer]       адрес для приёма и журнала (по умолчанию — адрес сокета)
 * @param {(n:number, hint:string)=>void} [o.onNoise]  отброшено n байт вне кадра (сигнал прибора);
 *        LIS_VENDOR_EXACT_V1 — hint: на что похожи (noiseHint)
 * @param {string} [o.label]      LIS_VENDOR_EXACT_V1 — как назвать соединение в журнале («ip:порт»)
 * @param {(o:{peer:string, bytes:number, head:string})=>void} [o.onAbandoned]
 *        LIS_REAL_ANALYZERS_V1 (ревью R2, п. 10а) — прибор бросил кадр и начал
 *        новый (новый VT до FS): здесь — начало брошенного (первые 64 КБ), для
 *        одной строки лотка. Ответа прибору на брошенный нет — он его не ждёт.
 * @param {(msh:object)=>{layout?:string, wire?:string}} [o.replyStyle]
 *        LIS_VENDOR_EXACT_V1 — вид ответа, который читатель строит сам (приём
 *        бросил, вернул только код, переросшее): по заголовку входящего
 *        (mshOf). Нет — вид руководства (hl7.js LAYOUT_LONG).
 */
export function attachMllpReader(sock, { onMessage, onOversize = null, maxBytes = DEFAULT_MAX_BYTES, log = () => {}, peer = sock.remoteAddress || '', onNoise = null, onAbandoned = null, replyStyle = null, label = peer } = {}) {
  let buf = Buffer.alloc(0);
  let overflow = false;
  // LIS_VENDOR_EXACT_V1 — вид ответа вызывающего; его сбой ответа не отменяет.
  const styleOf = (msh) => {
    if (!replyStyle) return {};
    try { return replyStyle(msh) || {}; } catch { return {}; }
  };
  // Обработка кадров последовательная: прибор ждёт ответа на первый кадр
  // прежде, чем слать второй, и параллельная запись в базу переставила бы
  // ответы местами.
  let chain = Promise.resolve();
  // LIS_VENDOR_EXACT_V1 — D14: байты вне кадра больше не пропадают молча:
  // вызывающему (onNoise) — сколько и на что похожи, в журнал — с подсказкой
  // протокола, одна строка на вид за минуту (с числом пропущенных). Сигнал
  // 0x02 гематологии — не беда: в журнал не идёт.
  const loggedAt = new Map();
  const skipped = new Map();
  const noise = (from, to) => {
    const n = noiseBytes(buf, from, to);
    if (!n) return;
    const hint = noiseHint(buf.subarray(from, to));
    if (onNoise) onNoise(n, hint);
    if (hint === 'heartbeat') return;
    const now = Date.now();
    if (loggedAt.has(hint) && now - loggedAt.get(hint) < NOISE_LOG_MS) {
      skipped.set(hint, (skipped.get(hint) || 0) + 1);
      return;
    }
    const more = skipped.get(hint) || 0;
    loggedAt.set(hint, now);
    skipped.set(hint, 0);
    log(`LIS: ${label} — ${n} байт не в кадре MLLP: ${HINT_TEXT[hint] || HINT_TEXT.other}${more ? ` (и ещё ${more} таких же за минуту)` : ''}`);
  };

  // LIS_MINDRAY_CODES_V1 (ревью 2026-09-28) — сообщение больше потолка.
  // Раньше соединение рвалось молча: ни NAK, ни записи, и проба с
  // картинками пропадала бесследно. Теперь, как обещала спецификация
  // («Ошибки»): прибору AE с номером сообщения (если начало разбирается),
  // вызывающему — начало текста для лотка, потом соединение закрыто.
  // Не копим по-прежнему: тот, кто не представился, не должен уметь съесть
  // память, поэтому всё, что придёт после отказа, выбрасывается.
  function refuse(body) {
    overflow = true;
    buf = Buffer.alloc(0);
    const bytes = body.length;
    const head = decodeFrame(body.subarray(0, HEAD_BYTES), { head: true });   // LIS_VENDOR_EXACT_V1 — D10
    log(`LIS: сообщение больше ${maxBytes} байт от ${peer} — отказ, соединение закрыто`);
    // В ту же цепочку: ответы на кадры, пришедшие раньше, уходят первыми.
    chain = chain.then(async () => {
      const m = mshOf(head);
      if (!sock.destroyed) sock.write(frameOf(internalAck(m, styleOf(m))));   // LIS_VENDOR_EXACT_V1 — в виде прибора
      try {
        if (onOversize) await onOversize({ peer, bytes, head, limit: maxBytes });
      } catch (e) {
        log('LIS: переросшее сообщение не записано — ' + (e && e.message ? e.message : e));
      }
      if (sock.destroyed) return;
      // LIS_VENDOR_EXACT_V1 — D4: без FIN (end): прибор дочитывает отказ за
      // паузу, потом соединение рвётся RST — после FIN A1000 не заметил бы
      // обрыва и потерял бы следующий результат.
      const t = setTimeout(() => resetSocket(sock), OVERSIZE_GRACE_MS);
      if (t.unref) t.unref();
    });
  }

  sock.on('data', (chunk) => {
    if (overflow) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    for (;;) {
      const start = buf.indexOf(VT);
      if (start === -1) break;
      const end = buf.indexOf(FS, start + 1);
      // LIS_REAL_ANALYZERS_V1 (ревью R2, п. 10а) — новый VT раньше конца кадра:
      // прибор бросил кадр и начал новый. Раньше новый кадр прирастал к
      // брошенному, и приём получал склейку двух сообщений (ответ — с номером
      // брошенного). Теперь брошенное начало — вызывающему, одной строкой
      // лотка, а новый кадр начинается с нового VT.
      const next = buf.indexOf(VT, start + 1);
      if (next !== -1 && (end === -1 || next < end)) {
        noise(0, start);
        const cut = buf.subarray(start + 1, next);
        const head = decodeFrame(cut.subarray(0, HEAD_BYTES), { head: true });   // LIS_VENDOR_EXACT_V1 — D10: брошенный мог оборваться посреди знака
        log(`LIS: кадр от ${peer} брошен на середине — прибор начал новый`);
        if (onAbandoned) {
          chain = chain.then(async () => {
            try { await onAbandoned({ peer, bytes: cut.length, head }); } catch (e) { log('LIS: брошенный кадр не записан — ' + (e && e.message ? e.message : e)); }
          });
        }
        buf = buf.subarray(next);
        continue;
      }
      if (end === -1) break;   // кадр ещё не пришёл целиком
      // Потолок — на одно сообщение, а не на то, что пришло одной записью:
      // целый кадр больше потолка отвергается так же, как недошедший.
      if (end - start - 1 > maxBytes) { refuse(buf.subarray(start + 1, end)); return; }

      noise(0, start);
      const text = decodeFrame(buf.subarray(start + 1, end));   // LIS_VENDOR_EXACT_V1 — D10: UTF-8, иначе windows-1251
      // За FS обычно идёт CR — съедаем и его, если он там.
      buf = buf.slice(end + 1 < buf.length && buf[end + 1] === CR ? end + 2 : end + 1);

      chain = chain.then(async () => {
        const msh = mshOf(text);
        let ack;
        try {
          const r = await onMessage(text, peer);
          const code = r && typeof r === 'object' ? r.code : r;
          if (r && typeof r === 'object' && typeof r.reply === 'string' && r.reply) ack = r.reply;
          // LIS_VENDOR_EXACT_V1 — ответ, который строим сами, — в виде прибора.
          else ack = code ? buildAck(msh, code, { layout: styleOf(msh).layout }) : internalAck(msh, styleOf(msh));
        } catch (e) {
          ack = internalAck(msh, styleOf(msh));   // LIS_VENDOR_EXACT_V1
          log('LIS: приём отказал — ' + (e && e.message ? e.message : e));
        }
        if (sock.destroyed) return;
        sock.write(frameOf(ack));
      });
    }

    // LIS_REAL_ANALYZERS_V1_DIAL — всё до первого VT — не кадр: отбрасывается
    // сейчас, а не копится до потолка.
    const vt = buf.indexOf(VT);
    if (vt === -1) { noise(0, buf.length); buf = Buffer.alloc(0); } else if (vt > 0) { noise(0, vt); buf = buf.subarray(vt); }

    // Начатый кадр перерос потолок, а конца всё нет.
    if (buf.length > maxBytes) {
      const start = buf.indexOf(VT);
      refuse(buf.subarray(start === -1 ? 0 : start + 1));
    }
  });
}

/**
 * @param {object} o
 * @param {number} o.port          0 — занять свободный (тесты)
 * @param {(text:string, peer:string)=>Promise<'AA'|'AE'|'AR'|{code:string, reply?:string}>} o.onMessage
 *        код ответа — или (LIS_REAL_ANALYZERS_V1_SERVICE) готовый ответ { reply }:
 *        на запрос рабочего списка уходит не ACK, а QCK^Q02 / DSR^Q01
 * @param {number} [o.maxBytes]    потолок одного сообщения (DEFAULT_MAX_BYTES)
 * @param {(o:{peer:string, bytes:number, head:string, limit:number})=>void} [o.onOversize]
 *        сообщение больше потолка: прибору уже ушёл AE, здесь — сколько пришло
 *        к моменту отказа, первые 64 КБ текста и сам потолок (запись в лоток)
 * @param {(msg:string)=>void} [o.log]
 * @param {(msh:object)=>{layout?:string, wire?:string}} [o.replyStyle]
 *        LIS_VENDOR_EXACT_V1 — вид ответов, которые провод строит сам
 *        (attachMllpReader); index.js даёт receive.js replyStyle
 * @returns {Promise<{port:number, close:()=>Promise<void>, peers:()=>Array<object>}>}
 *   peers — LIS_VENDOR_EXACT_V1, D14: последние соединения с этим портом, новые
 *   первыми: { ip, port, remotePort, connectedAt, lastRxAt, frames, noiseBytes,
 *   noiseHint, open, closedAt }; port — порт приёма (этого слушателя),
 *   remotePort — порт прибора; noiseBytes/noiseHint — байты не в кадре, кроме
 *   сигнала 0x02 (noiseHint), — то, по чему экран говорит «приходят данные,
 *   которые Easy-Med не понимает»; время — ISO без миллисекунд.
 */
export function startMllpServer({ port, onMessage, onOversize = null, onAbandoned = null, maxBytes = DEFAULT_MAX_BYTES, log = () => {}, replyStyle = null }) {
  return new Promise((resolve, reject) => {
    // LIS_DISCOVERY_FIX_V1 (ревью 2026-09-29) — открытые соединения приборов.
    // server.close() перестаёт принимать новые, но отвечает, только когда
    // закроются ВСЕ открытые, а анализатор держит своё часами. На этом висели
    // lis_restart и lis_device_delete. Поэтому сокеты помнятся, и закрытие
    // рвёт их само.
    // LIS_VENDOR_EXACT_V1 — D4: рвёт RST (resetSocket). Прибор переподключится
    // к новому слушателю; неотвеченный кадр пришлёт снова не каждый: A1000 не
    // повторяет никогда (autobio-autolumo-a1000.md §4), поэтому слушатель
    // закрывается, только когда его порт больше не нужен (index.js).
    const socks = new Set();
    // LIS_VENDOR_EXACT_V1 — D14: кто подключался к порту и что прислал — для
    // экрана «Анализаторы» (index.js listenerStatus().peers). Раньше прибор,
    // который подключился и шлёт не HL7, выглядел так же, как «никто не
    // подключался». Последние PEERS_KEPT соединений, открытые — все.
    const peers = [];
    const trimPeers = () => {
      while (peers.length > PEERS_KEPT) {
        const i = peers.findIndex((p) => !p.open);
        if (i === -1) break;
        peers.splice(i, 1);
      }
    };
    const server = net.createServer((sock) => {
      socks.add(sock);
      // LIS_VENDOR_EXACT_V1 — D14: соединение — в журнал (адрес и порт прибора)
      // и в список для экрана.
      const ip = String(sock.remoteAddress || '').replace(/^::ffff:/, '');
      const rec = { ip, port: sock.localPort || null, remotePort: sock.remotePort || null, connectedAt: isoNow(),
        lastRxAt: null, frames: 0, noiseBytes: 0, noiseHint: null, open: true, closedAt: null };
      const label = `${ip}:${rec.remotePort}`;
      peers.push(rec);
      trimPeers();
      log(`LIS: подключение ${label} к порту ${rec.port}`);
      sock.on('data', () => { rec.lastRxAt = isoNow(); });
      sock.on('close', () => {
        socks.delete(sock);
        rec.open = false;
        rec.closedAt = isoNow();
        trimPeers();
        log(`LIS: соединение ${label} закрыто (кадров: ${rec.frames}${rec.noiseBytes ? ', байт не в кадре: ' + rec.noiseBytes : ''})`);
      });
      // LIS_VENDOR_EXACT_V1 — D4: простоя нет (прибор молчит часами), TCP
      // keep-alive убирает мёртвых; NoDelay — ответ уходит сразу, два ответа
      // не склеиваются в один сегмент (A1000 вырезает ответ регуляркой
      // ^\v…\x1C\r$ — autobio-autolumo-a1000.md M19).
      sock.setKeepAlive(true, KEEPALIVE_MS);
      sock.setNoDelay(true);
      // LIS_REAL_ANALYZERS_V1_DIAL — разбор кадров вынесен: тот же читатель у
      // клиента, который звонит прибору сам (dial.js).
      attachMllpReader(sock, {
        onMessage: (text, peer) => { rec.frames++; return onMessage(text, peer); },   // LIS_VENDOR_EXACT_V1 — D14: счёт кадров
        // LIS_VENDOR_EXACT_V1 — D14: сигнал 0x02 — не «непонятные данные».
        onNoise: (n, hint) => { if (hint === 'heartbeat') return; rec.noiseBytes += n; rec.noiseHint = hint; },
        label,
        onOversize, onAbandoned, maxBytes, log, peer: sock.remoteAddress || '', replyStyle,   // onAbandoned: ревью R2, п. 10а; replyStyle: LIS_VENDOR_EXACT_V1
      });
      sock.on('error', () => sock.destroy());
    });

    server.on('error', (e) => {
      // Тот же дружелюбный разбор, что server/index.js делает для HTTP-порта:
      // оператор, запустивший второй раз, должен увидеть слова, а не стек.
      if (e && e.code === 'EADDRINUSE') {
        // LIS_ANALYZER_LIST_V1 (ревью M6) — код едет дальше вместе с текстом:
        // экран «Анализаторы» по нему пишет «порт N занят другой программой»
        // своими словами, а этот текст остаётся журналу.
        const busy = new Error(`LIS: порт ${port} уже занят — вероятно, Easy-Med уже запущен`);
        busy.code = 'EADDRINUSE';
        reject(busy);
      } else reject(e);
    });

    server.listen(port, '0.0.0.0', () => {
      // unref по той же причине, что у таймеров опроса телефонии: слушатель
      // анализатора не должен УДЕРЖИВАТЬ процесс живым. В приложении его и так
      // держит HTTP-сервер, а вот в тестах открытый порт означал бы, что
      // `node --test` ждёт вечно — так и случилось, когда порт стал
      // открываться всегда (LIS_AUTODISCOVER_V1), а не только под заведённый
      // прибор.
      server.unref();
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => {
          for (const s of socks) resetSocket(s);   // LIS_VENDOR_EXACT_V1 — D4: RST, не FIN
          server.close(() => r());
        }),
        peers: () => peers.slice().reverse().map((p) => ({ ...p })),   // LIS_VENDOR_EXACT_V1 — D14: копии, новые первыми
      });
    });
  });
}
