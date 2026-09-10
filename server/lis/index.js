// LIS_INGEST_V1 — поднять слушатели анализаторов по включённым устройствам.
//
// ОДИН слушатель на ЗАНЯТЫЙ ПОРТ, а не один на устройство: два прибора,
// настроенных на 2575, иначе подрались бы за него, и второй молча не поднялся
// бы — а молча неработающий приём результатов хуже явно ненастроенного.
//
// Какому устройству принадлежит пришедшее сообщение:
//   1. по адресу отправителя, если у устройства заполнен host;
//   2. иначе — по единственному включённому устройству на этом порту;
//   3. иначе устройство не определено: сообщение сохраняется с device_id = NULL
//      и видно в лотке. Лечится тем, что клиника проставляет host или разводит
//      приборы по разным портам.
import { startMllpServer } from './mllp.js';
import { ingestMessage } from './ingest.js';

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
  if (!devices.length) return [];

  const byPort = new Map();
  for (const d of devices) {
    const port = d.port || 2575;
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
          let device = list.find((d) => d.host && normalizeIp(d.host) === ip);
          if (!device && list.length === 1) device = list[0];
          return ingestMessage(db, text, ip, device ? device.id : null);
        },
      });
      running.push(srv);
      log(`LIS: порт ${srv.port} слушает (${list.map((d) => d.name).join(', ')})`);
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
