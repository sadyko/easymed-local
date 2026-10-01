// LIS_INGEST_V1 — MLLP: кадрирование HL7 поверх TCP.
//
// Кадр: 0x0B <текст> 0x1C 0x0D. Прибор может прислать кадр кусками, может
// прислать два кадра в одной записи, и обязан получить ответ прежде, чем
// пошлёт следующий.
//
// Порт неаутентифицирован — анализаторы не умеют логиниться (спецификация,
// «Безопасность»). Отсюда потолок размера и тайм-аут простоя: это единственное,
// чем можно ограничить того, кто не представился.
import net from 'node:net';
import { buildAck, mshOf, ACK_INTERNAL } from './hl7.js';   // mshOf, ACK_INTERNAL: LIS_REAL_ANALYZERS_V1_ACK

export const VT = 0x0b;
export const FS = 0x1c;
export const CR = 0x0d;

// LIS_MINDRAY_CODES_V1 (ревью 2026-09-28) — потолок 4 МБ, а не 256 КБ.
// Настоящий Mindray кладёт в пробу картинки: гистограммы и скаттерграммы BMP в
// base64 (строки ED). Такое сообщение легко больше 256 КБ, и тогда результаты
// не приходили вовсе — соединение рвалось молча. 4 МБ — с запасом на тяжёлые
// пробы и всё ещё предел для того, кто не представился.
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const IDLE_MS = 5 * 60 * 1000;
// Сколько начала переросшего сообщения отдать вызывающему (в лоток): MSH, PID,
// OBR и числа идут первыми, картинки — в конце. 64 КБ хватает, чтобы узнать
// пробу, и не превращают лоток в склад картинок.
const HEAD_BYTES = 64 * 1024;
// После отказа прибору дают дочитать ответ, прежде чем оборвать соединение:
// тот, кто продолжает слать, не держит его дольше этого.
const OVERSIZE_GRACE_MS = 2000;

const frameOf = (text) => Buffer.concat([Buffer.from([VT]), Buffer.from(text, 'utf8'), Buffer.from([FS, CR])]);

// LIS_REAL_ANALYZERS_V1_ACK — заголовок входящего читает mshOf (hl7.js) без
// исключений, вместо прежнего controlIdOf: ответить надо и на то, что разобрать
// не удалось, иначе прибор не поймёт, на что пришёл отказ. Ответ — buildAck с
// эхом заголовка; сорвавшийся приём и переросшее — AE 207 (ACK_INTERNAL), а не
// «ошибка разбора» 100: сообщение могло быть верным.

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
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
export function startMllpServer({ port, onMessage, onOversize = null, maxBytes = DEFAULT_MAX_BYTES, log = () => {} }) {
  return new Promise((resolve, reject) => {
    // LIS_DISCOVERY_FIX_V1 (ревью 2026-09-29) — открытые соединения приборов.
    // server.close() перестаёт принимать новые, но отвечает, только когда
    // закроются ВСЕ открытые, а анализатор держит своё часами (простой рвётся
    // через IDLE_MS). На этом висели lis_restart и lis_device_delete. Поэтому
    // сокеты помнятся, и закрытие рвёт их само: прибор переподключится к новому
    // слушателю, а неотвеченный кадр пришлёт снова.
    const socks = new Set();
    const server = net.createServer((sock) => {
      socks.add(sock);
      sock.on('close', () => socks.delete(sock));
      const peer = sock.remoteAddress || '';
      let buf = Buffer.alloc(0);
      let overflow = false;
      // Обработка кадров последовательная: прибор ждёт ответа на первый кадр
      // прежде, чем слать второй, и параллельная запись в базу переставила бы
      // ответы местами.
      let chain = Promise.resolve();

      sock.setTimeout(IDLE_MS, () => sock.destroy());

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
        const head = body.subarray(0, HEAD_BYTES).toString('utf8');
        log(`LIS: сообщение больше ${maxBytes} байт от ${peer} — отказ (AE), соединение закрыто`);
        // В ту же цепочку: ответы на кадры, пришедшие раньше, уходят первыми.
        chain = chain.then(async () => {
          if (!sock.destroyed) sock.write(frameOf(buildAck(mshOf(head), 'AE', ACK_INTERNAL)));
          try {
            if (onOversize) await onOversize({ peer, bytes, head, limit: maxBytes });
          } catch (e) {
            log('LIS: переросшее сообщение не записано — ' + (e && e.message ? e.message : e));
          }
          if (sock.destroyed) return;
          sock.end();
          const t = setTimeout(() => sock.destroy(), OVERSIZE_GRACE_MS);
          if (t.unref) t.unref();
        });
      }

      sock.on('data', (chunk) => {
        if (overflow) return;
        buf = Buffer.concat([buf, chunk]);

        for (;;) {
          const start = buf.indexOf(VT);
          if (start === -1) break;
          const end = buf.indexOf(FS, start + 1);
          if (end === -1) break;   // кадр ещё не пришёл целиком
          // Потолок — на одно сообщение, а не на то, что пришло одной записью:
          // целый кадр больше потолка отвергается так же, как недошедший.
          if (end - start - 1 > maxBytes) { refuse(buf.subarray(start + 1, end)); return; }

          const text = buf.slice(start + 1, end).toString('utf8');
          // За FS обычно идёт CR — съедаем и его, если он там.
          buf = buf.slice(end + 1 < buf.length && buf[end + 1] === CR ? end + 2 : end + 1);

          chain = chain.then(async () => {
            const msh = mshOf(text);
            let ack;
            try {
              const r = await onMessage(text, peer);
              const code = r && typeof r === 'object' ? r.code : r;
              if (r && typeof r === 'object' && typeof r.reply === 'string' && r.reply) ack = r.reply;
              else ack = code ? buildAck(msh, code) : buildAck(msh, 'AE', ACK_INTERNAL);
            } catch (e) {
              ack = buildAck(msh, 'AE', ACK_INTERNAL);
              log('LIS: приём отказал — ' + (e && e.message ? e.message : e));
            }
            if (sock.destroyed) return;
            sock.write(frameOf(ack));
          });
        }

        // Начатый кадр перерос потолок, а конца всё нет.
        if (buf.length > maxBytes) {
          const start = buf.indexOf(VT);
          refuse(buf.subarray(start === -1 ? 0 : start + 1));
        }
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
          for (const s of socks) s.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}
