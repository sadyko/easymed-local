// LIS_INGEST_V1 / LIS_AUTODISCOVER_V1 — слушатели анализаторов.
//
// Порт по умолчанию слушается ВСЕГДА, даже когда у клиники не заведено ни
// одного прибора. Это решение владельца: «we should not setup anything» —
// анализатор обязан появиться в списке сам, как только заговорил. Пока порт
// открывался только под заведённый прибор, наладка упиралась в шаг, который
// инженер не мог сделать заранее: он не знал ни адреса прибора, ни того, как
// тот себя называет.
//
// ОДИН слушатель на ЗАНЯТЫЙ ПОРТ, а не один на устройство: два прибора,
// настроенных на 2575, иначе подрались бы за него, и второй молча не поднялся
// бы — а молча неработающий приём результатов хуже явно ненастроенного.
import { startMllpServer } from './mllp.js';
import { receiveMessage } from './receive.js';   // LIS_REAL_ANALYZERS_V1_SERVICE — проба или служебное, и ответ прибору
import { readEnvelope, readResult, pickSampleId } from './wire.js';   // LIS_REAL_ANALYZERS_V1_SERVICE / _SAMPLE — вид, имя отправителя, номер пробы
import { ensureDevice } from './discover.js';
import { recordMessage, OVERSIZE_DETAIL_PREFIX } from './inbox.js';   // LIS_MINDRAY_CODES_V1 — переросшее сообщение ложится в лоток

export const DEFAULT_PORT = 2575;

let running = [];
// LIS_ANALYZER_LIST_V1 — порты, которые не поднялись (занял кто-то другой):
// экран «Анализаторы» говорит это у ждущего прибора, а не только журнал.
let failed = [];

/** IPv4-mapped IPv6 ('::ffff:10.0.0.9') → '10.0.0.9'. */
const normalizeIp = (peer) => String(peer || '').replace(/^::ffff:/, '');

export async function startLisListeners(db, { log = console.log } = {}) {
  await stopLisListeners();
  failed = [];
  if (process.env.LIS_ENABLED === '0') {
    log('LIS: выключен через LIS_ENABLED=0');
    return [];
  }

  const devices = db.prepare("SELECT * FROM lab_devices WHERE enabled = 1 AND transport = 'mllp'").all();

  // Порт по умолчанию есть в списке всегда — даже с пустой клиникой.
  const byPort = new Map([[Number(process.env.LIS_PORT) || DEFAULT_PORT, []]]);
  for (const d of devices) {
    const port = d.port || DEFAULT_PORT;
    if (!byPort.has(port)) byPort.set(port, []);
    byPort.get(port).push(d);
  }

  for (const [port, list] of byPort) {
    try {
      const srv = await startMllpServer({
        port,
        log,
        onMessage: async (text, peer) => {
          const ip = normalizeIp(peer);

          // Кто прислал — решает ТОЛЬКО ensureDevice. Свой быстрый поиск «по
          // адресу» здесь уже был и оказался вреден: он обходил проверку модели
          // и приписывал второй анализатор, стоящий за тем же адресом, к первой
          // найденной строке. Два набора правил про одно и то же неизбежно
          // расходятся — правило должно быть одно, и оно там.
          //
          // LIS_REAL_ANALYZERS_V1_SERVICE — «разобрано» теперь значит проба
          // ИЛИ служебное (контроль, калибровка, запрос рабочего списка): прибор,
          // который сначала спросил заказ, появляется в «Найдены в сети» с
          // первого запроса. Мусор и неподдержанный тип (ADT^A01) прибора не
          // заводят и имени не дают — как прежде, когда parseMessage бросал.
          const env = readEnvelope(text);
          const parsed = env.kind === 'result' || env.service;
          const sendingApp = parsed ? env.app : '';
          // LIS_REAL_ANALYZERS_V1_MODEL — MSH-4: модель угадывается и по нему
          // (BS-200 называет себя «Mindray|BS-200E»), строка его запоминает.
          const sendingFacility = parsed ? env.facility : '';

          const found = ensureDevice(db, { sendingApp, sendingFacility, peer: ip, port, allowCreate: parsed });
          if (found.created) {
            log(`LIS: обнаружен анализатор «${found.device.name}» (${ip || 'адрес неизвестен'}), порт ${port}`);
            list.push(found.device);
          }

          return receiveMessage(db, text, { peer: ip, deviceId: found.device ? found.device.id : null });
        },
        // LIS_MINDRAY_CODES_V1 (ревью 2026-09-28) — сообщение больше потолка
        // (mllp.js уже ответил прибору AE). Инвариант 2 — ничего не теряется:
        // строка ложится в лоток как «Не разобрано», с началом текста и
        // номером пробы, если он в начале есть. Лаборант видит, чья проба не
        // дошла, а не узнаёт об этом от врача. Прибор по началу не заводится:
        // целого сообщения нет, а второй набор правил рядом с ensureDevice —
        // ровно то, от чего здесь уже отказались.
        onOversize: ({ peer, head, limit }) => {
          const ip = normalizeIp(peer);
          // LIS_REAL_ANALYZERS_V1_SAMPLE — номер той же pickSampleId с проводом
          // default: LAB- узнаётся в OBR-2 и OBR-3, голые цифры — только OBR-3.
          // Начало не разобралось — без номера (readResult не бросает).
          const sampleId = pickSampleId(readResult(head, 'default').obr, 'default').sampleId;
          const size = limit >= 1024 * 1024 ? (limit / (1024 * 1024)) + ' МБ' : Math.round(limit / 1024) + ' КБ';
          // LIS_DISCOVERY_FIX_V1 — начало строки общее с привязкой (rpc/lis.js):
          // по нему она отказывается привязывать обрезанное. Текст прежний.
          recordMessage(db, { deviceId: null, peer: ip, raw: head, sampleId, status: 'rejected',
            detail: OVERSIZE_DETAIL_PREFIX + size + ' — не принято; в лотке только его начало' });
        },
      });
      running.push(srv);
      log(list.length
        ? `LIS: порт ${srv.port} слушает (${list.map((d) => d.name).join(', ')})`
        : `LIS: порт ${srv.port} слушает, ждёт первый анализатор`);
    } catch (e) {
      // Приложение НЕ роняем: неподнявшийся слушатель — это неработающий
      // анализатор, а не неработающая клиника. Регистратура, касса и приём
      // пациентов не должны останавливаться из-за занятого порта.
      // Ревью M6: причина — кодом ('busy' — порт занят, 'error' — прочее);
      // текст — для журнала, экран говорит своими словами на языке интерфейса.
      failed.push({ port, code: e && e.code === 'EADDRINUSE' ? 'busy' : 'error', error: e && e.message ? e.message : String(e) });
      log('LIS: ' + (e && e.message ? e.message : e));
    }
  }
  return running;
}

export async function stopLisListeners() {
  const old = running;
  running = [];
  for (const s of old) {
    try { await s.close(); } catch { /* уже закрыт — это не ошибка */ }
  }
}

/** Сколько слушателей поднято сейчас. Для экрана «Анализаторы» и тестов. */
export function listenerCount() { return running.length; }

/**
 * LIS_ANALYZER_LIST_V1 — какие порты слушаются прямо сейчас и какие не
 * поднялись. Для строки «порт N слушается» у ждущего прибора в окне
 * «Добавить прибор» — это и есть проверка связи с нашей стороны.
 */
export function listenerStatus() {
  return { listening: running.map((s) => s.port), failed: failed.map((f) => ({ ...f })) };
}
