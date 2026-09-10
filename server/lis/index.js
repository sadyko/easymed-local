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
import { ingestMessage } from './ingest.js';
import { ensureDevice } from './discover.js';
import { parseMessage } from './hl7.js';

export const DEFAULT_PORT = 2575;

let running = [];

/** IPv4-mapped IPv6 ('::ffff:10.0.0.9') → '10.0.0.9'. */
const normalizeIp = (peer) => String(peer || '').replace(/^::ffff:/, '');

export async function startLisListeners(db, { log = console.log } = {}) {
  await stopLisListeners();
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
          let sendingApp = '';
          let parsed = true;
          try { sendingApp = parseMessage(text).sendingApp || ''; } catch { parsed = false; }

          const found = ensureDevice(db, { sendingApp, peer: ip, port, allowCreate: parsed });
          if (found.created) {
            log(`LIS: обнаружен анализатор «${found.device.name}» (${ip || 'адрес неизвестен'}), порт ${port}`);
            list.push(found.device);
          }

          return ingestMessage(db, text, ip, found.device ? found.device.id : null);
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
