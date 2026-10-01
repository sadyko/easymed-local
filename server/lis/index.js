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
//
// LIS_REAL_ANALYZERS_V1_DIAL — и клиенты к приборам, которые сами не звонят, а
// ждут звонка LIS (lab_devices.dial = 1; Mindray BC-3600, возможно BC-780):
// поднимаются и гасятся здесь же, вместе со слушателями.
import os from 'node:os';   // LIS_REAL_ANALYZERS_V1_DIAL — свои адреса: нет петли на себя
import net from 'node:net';   // LIS_REAL_ANALYZERS_V1 — ревью R2, п. 7: адрес IPv6 к одному виду
import { startMllpServer } from './mllp.js';
import { startMllpClient, isLocalIp } from './dial.js';   // LIS_REAL_ANALYZERS_V1_DIAL — Easy-Med подключается к прибору сам
import { receiveMessage } from './receive.js';   // LIS_REAL_ANALYZERS_V1_SERVICE — проба или служебное, и ответ прибору
import { readEnvelope, readResult, pickMessageSample } from './wire.js';   // LIS_REAL_ANALYZERS_V1_SERVICE / _SAMPLE — вид, имя отправителя, номер пробы
import { ensureDevice, learnSender } from './discover.js';   // learnSender: LIS_REAL_ANALYZERS_V1_DIAL
import { recordMessage, OVERSIZE_DETAIL_PREFIX } from './inbox.js';   // LIS_MINDRAY_CODES_V1 — переросшее сообщение ложится в лоток
import { ABANDONED_DETAIL_PREFIX } from './inbox.js';   // LIS_REAL_ANALYZERS_V1 — ревью R2, п. 10а

export const DEFAULT_PORT = 2575;

let running = [];
// LIS_ANALYZER_LIST_V1 — порты, которые не поднялись (занял кто-то другой):
// экран «Анализаторы» говорит это у ждущего прибора, а не только журнал.
let failed = [];
// LIS_REAL_ANALYZERS_V1_DIAL — приборы, к которым Easy-Med подключается сам:
// клиенты по номеру строки и строки, которым клиент не поднят (дубль адреса,
// адрес не из локальной сети, петля на себя).
let dialers = new Map();
let dialRefused = [];

/** IPv4-mapped IPv6 ('::ffff:10.0.0.9') → '10.0.0.9'. */
const normalizeIp = (peer) => String(peer || '').replace(/^::ffff:/, '');

const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * LIS_MINDRAY_CODES_V1 (ревью 2026-09-28) — сообщение больше потолка (mllp.js
 * уже ответил прибору AE). Инвариант 2 — ничего не теряется: строка ложится в
 * лоток как «Не разобрано», с началом текста и номером пробы, если он в начале
 * есть. Лаборант видит, чья проба не дошла, а не узнаёт об этом от врача.
 * deviceId: у слушателя — null (прибор по началу не заводится: целого
 * сообщения нет, а второй набор правил рядом с ensureDevice — ровно то, от чего
 * здесь уже отказались); у звонка прибору (LIS_REAL_ANALYZERS_V1_DIAL) прибор
 * известен заранее.
 */
/**
 * LIS_REAL_ANALYZERS_V1 (ревью R2, п. 10б) — такая же строка («больше
 * потолка», «кадр оборван») от этого прибора (или, без прибора, с этого адреса)
 * уже лежит в лотке за последний час. Кадр в 5 МБ без конца ходит по кругу:
 * AE, обрыв, переподключение, снова — и раньше каждый круг писал строку лотка.
 * Теперь одна в час: прибор по-прежнему каждый раз получает отказ.
 *
 * Ревью R3, п. 4 — «такая же» — та же ПРОБА: тот же номер пробы, а без номера
 * — то же начало сообщения (первые SAME_HEAD_CHARS знаков; в нём MSH с номером
 * сообщения). Ключ «прибор + вид строки» гасил разные пробы: второй брошенный
 * кадр другой пробы за час терялся.
 */
const SAME_ROW_WINDOW_SECONDS = 60 * 60;
const SAME_HEAD_CHARS = 512;
function recentRow(db, { deviceId, peer, prefix, sampleId, head }) {
  return !!db.prepare(`SELECT 1 FROM lab_device_messages
                        WHERE status = 'rejected' AND substr(detail, 1, ?) = ?
                          AND received_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
                          AND (CASE WHEN ? IS NOT NULL THEN device_id = ? ELSE device_id IS NULL AND peer = ? END)
                          AND (CASE WHEN ? <> '' THEN sample_id = ? ELSE COALESCE(sample_id, '') = '' AND substr(raw, 1, ?) = ? END)
                        LIMIT 1`)
    .get(prefix.length, prefix, '-' + SAME_ROW_WINDOW_SECONDS + ' seconds', deviceId, deviceId, peer || '',
      sampleId || '', sampleId || '', SAME_HEAD_CHARS, String(head || '').slice(0, SAME_HEAD_CHARS));
}

function recordOversize(db, { deviceId = null, peer, head, limit }) {
  // LIS_REAL_ANALYZERS_V1_SAMPLE — номер той же pickSampleId с проводом
  // default: LAB- узнаётся в OBR-2 и OBR-3, голые цифры — только OBR-3.
  // Начало не разобралось — без номера (readResult не бросает).
  // LIS_REAL_ANALYZERS_V1 (ревью R1, п. 1) — по всем OBR начала, как у приёма.
  const sampleId = pickMessageSample(readResult(head, 'default').obrs, 'default').sampleId;
  if (recentRow(db, { deviceId, peer, prefix: OVERSIZE_DETAIL_PREFIX, sampleId, head })) return;   // ревью R2, п. 10б; R3, п. 4
  const size = limit >= 1024 * 1024 ? (limit / (1024 * 1024)) + ' МБ' : Math.round(limit / 1024) + ' КБ';
  // LIS_DISCOVERY_FIX_V1 — начало строки общее с привязкой (rpc/lis.js):
  // по нему она отказывается привязывать обрезанное. Текст прежний.
  recordMessage(db, { deviceId, peer, raw: head, sampleId, status: 'rejected',
    detail: OVERSIZE_DETAIL_PREFIX + size + ' — не принято; в лотке только его начало' });
}

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R2, п. 10а) — прибор бросил кадр и начал новый
 * (mllp.js onAbandoned): одна строка лотка «Не разобрано» с началом брошенного
 * и номером пробы, если он в начале есть (инвариант 2 — ничего не теряется).
 * Привязать её нельзя, как переросшее (rpc/lis.js — по началу строки). Не
 * чаще одной в час с прибора (адреса), как и переросшее.
 */
function recordAbandoned(db, { deviceId = null, peer, head }) {
  const sampleId = pickMessageSample(readResult(head, 'default').obrs, 'default').sampleId;
  if (recentRow(db, { deviceId, peer, prefix: ABANDONED_DETAIL_PREFIX, sampleId, head })) return;   // ревью R3, п. 4
  recordMessage(db, { deviceId, peer, raw: head, sampleId, status: 'rejected',
    detail: ABANDONED_DETAIL_PREFIX + 'прибор начал новый кадр, не закончив этот; в лотке только его начало — если проба не дошла, повторите её на приборе' });
}

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R2, п. 7) — адрес к одному виду: «::ffff:» у
 * IPv4 снимается, IPv6 записывается кратко («0:0:0:0:0:0:0:1» → «::1»), зона
 * («%eth0») отбрасывается. Иначе «127.0.0.1» и «::ffff:127.0.0.1» были двумя
 * адресами, и к одному прибору поднималось два соединения.
 */
function canonicalIp(host) {
  let h = String(host == null ? '' : host).trim().toLowerCase().split('%')[0];
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted) return dotted[1];
  if (net.isIP(h) === 6) {
    try { h = new URL('http://[' + h + ']/').hostname.slice(1, -1); } catch { /* как есть */ }
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (hex) {
      const a = parseInt(hex[1], 16);
      const b = parseInt(hex[2], 16);
      return [a >> 8, a & 255, b >> 8, b & 255].join('.');
    }
  }
  return h;
}

/**
 * LIS_REAL_ANALYZERS_V1_DIAL — порты, которые слушает сам Easy-Med: порты LIS
 * (переданные — или LIS_PORT / 2575 и поднятые сейчас), HTTP (PORT, 8000) и
 * EasyPhone (EASYPHONE_PORT, иначе HTTP + 20 — server/index.js). Звонок на свой
 * адрес с таким портом — петля на себя.
 */
export function selfPorts(lisPorts) {
  const http = Number(process.env.PORT || 8000);
  const phone = Number(process.env.EASYPHONE_PORT) || (http + 20);
  const lis = Array.isArray(lisPorts) ? lisPorts : [Number(process.env.LIS_PORT) || DEFAULT_PORT, ...running.map((s) => s.port)];
  return [...new Set([...lis, http, phone].filter((p) => Number.isInteger(p) && p > 0))];
}

/** Адрес этого компьютера: петля 127/8, ::1 и адреса его сетевых карт. */
function selfHost(host) {
  const h = String(host).toLowerCase().replace(/^::ffff:/, '').split('%')[0];
  if (h === '::1' || /^127\./.test(h)) return true;
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (String(a.address).toLowerCase().split('%')[0] === h) return true;
    }
  } catch { /* нет списка карт — остаётся петля */ }
  return false;
}

/**
 * LIS_REAL_ANALYZERS_V1_DIAL — клиенты к приборам, которые ждут звонка LIS
 * (lab_devices.dial = 1; спецификация, раздел 8). Один прибор — одно
 * соединение; исходящее — только на адрес и порт строки и только на IP
 * локальной сети. Отказ — кодом, без единой попытки соединения:
 *   bad_address — не IP (имя — это DNS, лишнее соединение), не локальная сеть
 *                 или порт не задан;
 *   self        — свой адрес и порт, который слушает сам Easy-Med;
 *   duplicate   — тот же адрес и порт уже у строки с меньшим номером.
 * Сообщение по такому соединению — тот же приём (receive.js: D4, D7, серия,
 * служебные): прибор известен заранее, ensureDevice не зовётся. Как прибор
 * назвал себя (MSH-3/4), дописывается в строку, если она этого ещё не знает, —
 * тогда, если прибор позже станет звонить сам, discover.js найдёт ту же строку.
 */
/**
 * LIS_REAL_ANALYZERS_V1 (ревью R3, п. 11) — кому звонить: чистое решение по
 * строкам приборов, без единого соединения. Адрес приводится к одному виду
 * (canonicalIp: без «::ffff:», IPv6 кратко, БЕЗ ЗОНЫ) только для проверки,
 * петли на себя и ключа дубля (ревью R2, п. 7); звонят по адресу строки как
 * есть — с зоной («fe80::1%eth0»): без неё ссылочный адрес IPv6 не набрать.
 * Ревью R4, п. E — зона остаётся только у IPv6: «10.0.0.5%eth0» (и
 * «::ffff:10.0.0.5%eth0») набирается без зоны; адрес, который с зоной не IP
 * («fe80::1%eth0%x», «fe80::1%»), — bad_address: такую строку connect отдал
 * бы в DNS.
 * @returns {Array<{device:object, device_id:number, host:string, port:number|null, code:string|null}>}
 *   host — адрес, по которому звонок; code — null или bad_address / self / duplicate.
 */
export function dialPlan(devices, lisPorts) {
  const mine = selfPorts(lisPorts);
  const taken = new Set();
  const out = [];
  for (const d of [...devices].sort((a, b) => a.id - b.id)) {
    const raw = String(d.host == null ? '' : d.host).trim();
    const port = d.port == null || d.port === '' ? NaN : Number(d.port);
    // (isLocalIp — прежний, общий с экраном: lab-devices-lists.js.)
    const key = canonicalIp(raw);
    const zoned = raw.includes('%');
    const v6 = net.isIP(key) === 6;
    const host = zoned && !v6 ? raw.slice(0, raw.indexOf('%')) : raw;   // ревью R4, п. E
    let code = null;
    if (!isLocalIp(key) || !Number.isInteger(port) || port < 1 || port > 65535 || (zoned && v6 && net.isIP(raw) !== 6)) code = 'bad_address';
    else if (selfHost(key) && mine.includes(port)) code = 'self';
    else if (taken.has(key + '|' + port)) code = 'duplicate';
    if (!code) taken.add(key + '|' + port);
    out.push({ device: d, device_id: d.id, host, port: Number.isInteger(port) ? port : null, code });
  }
  return out;
}

function startDialers(db, devices, lisPorts, log) {
  for (const { device: d, host, port, code } of dialPlan(devices, lisPorts)) {
    if (code) {
      dialRefused.push({ device_id: d.id, host, port, state: 'off',
        since: isoNow(), last_rx_at: null, code, retry_at: null });
      log(`LIS: «${d.name}» — Easy-Med не подключается к ${host || '(адрес пуст)'}:${port == null ? '(порт пуст)' : port} (${code})`);
      continue;
    }
    const deviceId = d.id;
    // Строку могли удалить, пока кадр шёл: сообщение всё равно сохраняется
    // (инвариант 2), но без прибора — иначе его не пустил бы внешний ключ.
    const alive = () => !!db.prepare('SELECT id FROM lab_devices WHERE id = ?').get(deviceId);
    const client = startMllpClient({
      host,
      port,
      log,
      onMessage: async (text) => {
        const known = alive();
        const env = readEnvelope(text);
        if (known && (env.kind === 'result' || env.service)) learnSender(db, deviceId, { app: env.app, facility: env.facility });
        return receiveMessage(db, text, { peer: host, deviceId: known ? deviceId : null });
      },
      onOversize: ({ head, limit }) => recordOversize(db, { deviceId: alive() ? deviceId : null, peer: host, head, limit }),
      onAbandoned: ({ head }) => recordAbandoned(db, { deviceId: alive() ? deviceId : null, peer: host, head }),   // ревью R2, п. 10а
    });
    // Ревью R2, п. 3 — прежний клиент этой строки (если вдруг остался) закрыт
    // прежде, чем его место займёт новый: сирота звонил бы прибору вечно.
    const prev = dialers.get(deviceId);
    if (prev) { try { prev.close(); } catch { /* уже закрыт */ } }
    dialers.set(deviceId, client);
    log(`LIS: Easy-Med подключается к «${d.name}» ${host}:${port}`);
  }
}

/**
 * LIS_REAL_ANALYZERS_V1 (ревью R2, п. 3) — запуск и остановка — по очереди.
 * Два запуска одновременно (два «Перезапустить» подряд, удаление прибора во
 * время перезапуска) раньше перемешивались на await: второй затирал клиента
 * первого в карте, не закрыв его, — сирота звонил прибору вечно, — а порт LIS
 * второй видел «уже занятым» первым. Теперь каждый ждёт, пока закончит
 * предыдущий; ошибка одного не останавливает очередь.
 */
let queue = Promise.resolve();
function inTurn(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

export function startLisListeners(db, opts = {}) {
  return inTurn(() => start(db, opts));
}

export function stopLisListeners() {
  return inTurn(stop);
}

async function start(db, { log = console.log } = {}) {
  await stop();
  failed = [];
  if (process.env.LIS_ENABLED === '0') {
    log('LIS: выключен через LIS_ENABLED=0');
    return [];
  }

  const devices = db.prepare("SELECT * FROM lab_devices WHERE enabled = 1 AND transport = 'mllp'").all();

  // Порт по умолчанию есть в списке всегда — даже с пустой клиникой.
  const byPort = new Map([[Number(process.env.LIS_PORT) || DEFAULT_PORT, []]]);
  for (const d of devices) {
    // LIS_REAL_ANALYZERS_V1_DIAL — к прибору, который ждёт звонка, Easy-Med
    // подключается сам: его порт — порт ПРИБОРА, слушать его здесь нельзя.
    if (Number(d.dial) === 1) continue;
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
        // LIS_MINDRAY_CODES_V1 (ревью 2026-09-28) — переросшее сообщение:
        // строка «Не разобрано» в лотке (recordOversize), прибор по началу не
        // заводится.
        onOversize: ({ peer, head, limit }) => recordOversize(db, { deviceId: null, peer: normalizeIp(peer), head, limit }),
        // LIS_REAL_ANALYZERS_V1 (ревью R2, п. 10а) — брошенный кадр: строка
        // «кадр оборван» в лотке; прибор по началу не заводится, как и выше.
        onAbandoned: ({ peer, head }) => recordAbandoned(db, { deviceId: null, peer: normalizeIp(peer), head }),
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

  // LIS_REAL_ANALYZERS_V1_DIAL — клиенты к приборам, ждущим звонка. Свои порты
  // — все, что слушатели ПЫТАЛИСЬ занять (и занятый чужой — тоже наш по смыслу).
  startDialers(db, devices.filter((d) => Number(d.dial) === 1), [...byPort.keys()], log);
  return running;
}

async function stop() {
  // LIS_REAL_ANALYZERS_V1_DIAL — клиенты закрываются сразу и ничего не ждут
  // (dial.js close): урок lis_restart / lis_device_delete — закрытие, ждущее
  // прибора, вешало RPC.
  const oldDialers = dialers;
  dialers = new Map();
  dialRefused = [];
  for (const c of oldDialers.values()) {
    try { c.close(); } catch { /* уже закрыт — это не ошибка */ }
  }
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
 *
 * LIS_REAL_ANALYZERS_V1_DIAL — dialing: соединения, которые Easy-Med держит сам,
 * по номеру строки прибора: { device_id, host, port, state, since, last_rx_at,
 * code, retry_at }. state — connecting / connected / waiting (dial.js) или off
 * (клиент не поднят: code bad_address / self / duplicate).
 */
export function listenerStatus() {
  const dialing = [
    ...[...dialers.entries()].map(([device_id, c]) => ({ device_id, ...c.status() })),
    ...dialRefused.map((r) => ({ ...r })),
  ].sort((a, b) => a.device_id - b.device_id);
  return { listening: running.map((s) => s.port), failed: failed.map((f) => ({ ...f })), dialing };
}
