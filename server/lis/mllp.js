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
import { buildAck } from './hl7.js';

export const VT = 0x0b;
export const FS = 0x1c;
export const CR = 0x0d;

const DEFAULT_MAX_BYTES = 256 * 1024;
const IDLE_MS = 5 * 60 * 1000;

/**
 * Достаёт номер сообщения (MSH-10) из сырого текста, не разбирая его целиком:
 * ответить надо и на то, что разобрать не удалось, иначе прибор не поймёт, на
 * что пришёл отказ.
 */
function controlIdOf(text) {
  const first = String(text || '').split(/\r\n?|\n/)[0] || '';
  if (!first.startsWith('MSH')) return '';
  const sep = first[3];
  const f = first.split(sep);
  return (f[9] || '').trim();
}

/**
 * @param {object} o
 * @param {number} o.port          0 — занять свободный (тесты)
 * @param {(text:string, peer:string)=>Promise<'AA'|'AE'>} o.onMessage
 * @param {number} [o.maxBytes]
 * @param {(msg:string)=>void} [o.log]
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
export function startMllpServer({ port, onMessage, maxBytes = DEFAULT_MAX_BYTES, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      const peer = sock.remoteAddress || '';
      let buf = Buffer.alloc(0);
      let overflow = false;
      // Обработка кадров последовательная: прибор ждёт ответа на первый кадр
      // прежде, чем слать второй, и параллельная запись в базу переставила бы
      // ответы местами.
      let chain = Promise.resolve();

      sock.setTimeout(IDLE_MS, () => sock.destroy());

      sock.on('data', (chunk) => {
        if (overflow) return;
        buf = Buffer.concat([buf, chunk]);

        if (buf.length > maxBytes) {
          // Не копим: тот, кто не представился, не должен уметь съесть память.
          overflow = true;
          log(`LIS: сообщение больше ${maxBytes} байт от ${peer} — соединение закрыто`);
          buf = Buffer.alloc(0);
          sock.destroy();
          return;
        }

        for (;;) {
          const start = buf.indexOf(VT);
          if (start === -1) break;
          const end = buf.indexOf(FS, start + 1);
          if (end === -1) break;   // кадр ещё не пришёл целиком

          const text = buf.slice(start + 1, end).toString('utf8');
          // За FS обычно идёт CR — съедаем и его, если он там.
          buf = buf.slice(end + 1 < buf.length && buf[end + 1] === CR ? end + 2 : end + 1);

          chain = chain.then(async () => {
            let code = 'AE';
            try {
              code = (await onMessage(text, peer)) || 'AE';
            } catch (e) {
              code = 'AE';
              log('LIS: приём отказал — ' + (e && e.message ? e.message : e));
            }
            if (sock.destroyed) return;
            const ack = buildAck(controlIdOf(text), code);
            sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(ack, 'utf8'), Buffer.from([FS, CR])]));
          });
        }
      });

      sock.on('error', () => sock.destroy());
    });

    server.on('error', (e) => {
      // Тот же дружелюбный разбор, что server/index.js делает для HTTP-порта:
      // оператор, запустивший второй раз, должен увидеть слова, а не стек.
      if (e && e.code === 'EADDRINUSE') {
        reject(new Error(`LIS: порт ${port} уже занят — вероятно, Easy-Med уже запущен`));
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
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
