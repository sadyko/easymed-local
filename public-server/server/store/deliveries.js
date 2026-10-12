// PUBLIC_SERVER_V1 — ДОСТАВКА УВЕДОМЛЕНИЙ ПАРТНЁРАМ (дизайн §8).
//
// Строку deliveries кладёт приём событий клиники (store/requests.js
// applyEvents): адрес, готовое тело и подпись клиники. Здесь — попытки:
//   • 2xx — доставлено;
//   • иначе повтор через 1, 5, 10, 30 и 60 минут (макет: «Повторяем 5 раз»),
//     после шестой неудачной попытки — «не доставлено»;
//   • негодный адрес — сразу «не доставлено» (лучше он не станет);
//   • тело уведомления стирается, как только доставка кончилась: хранить его
//     дальше незачем (в нём нет данных пациента, но и пользы нет).
// Каждая попытка — строка журнала доставок для клиники (8d: вкладка «Уведомления»).
//
// ЧЕСТНАЯ ОЧЕРЕДЬ (проверка 8b, C8). Один зависший адрес партнёра (10 секунд
// на попытку) не должен задерживать уведомления остальных — иначе «другое
// время» другой клиники доходит позже, чем на него можно ответить (30 минут):
//   • адрес считается по хосту И порту (endpointOf): неверный порт одной клиники
//     на хосте партнёра не трогает сам адрес партнёра;
//   • волна берёт подошедшие строки по кругу: сначала первую строку каждой пары
//     «клиника — адрес», потом вторую…; на один адрес — не больше
//     PER_HOST_PER_WAVE строк в волне;
//   • отправки идут непрерывно, до PARALLEL одновременно и не больше одной на
//     адрес — медленный адрес занимает один поток, а не всю волну;
//   • адрес, не ответивший соединением (timeout, connect, tls, DNS, запрещённый
//     адрес) HOST_TRIP_AFTER раз подряд, отдыхает 15 → 30 → 60 с (до
//     HOST_BACKOFF_MS; первый ответ адреса сбрасывает счёт). Его подошедшие строки ОТКЛАДЫВАЮТСЯ до
//     конца отдыха — без отправки и БЕЗ траты попытки (проверка исправлений 8b,
//     A: засчитанные «пропуски» сжигали расписание, и уведомления кончались «не
//     доставлено», ни разу не уйдя); в журнал — одна строка «host_down» на
//     переход строки в отсрочку;
//   • конец доставки — по попыткам (MAX_ATTEMPTS) ИЛИ по возрасту: строка живёт
//     не дольше DELIVERY_WINDOW_MS (всё расписание 1+5+10+30+60 минут и минута
//     запаса) — адрес, лежащий всегда, не держит строки бесконечно;
//   • сколько у клиники ждёт доставки — pendingCount: потолок очереди клиники
//     (PENDING_PER_CLINIC_MAX) держит приём событий (store/requests.js applyEvents).
import { appendDeliveryLog } from './logs.js';
import { checkWebhookUrl } from '../lib/webhook-send.js';
import { isoOf, msOf } from '../lib/time.js';

export const RETRY_MINUTES = Object.freeze([1, 5, 10, 30, 60]);
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
export const DELIVERY_WINDOW_MS = (RETRY_MINUTES.reduce((a, b) => a + b, 0) + 1) * 60000;
export const DELIVERY_KEEP_MS = 30 * 86400000;
export const WAVE_LIMIT = 20;
export const PARALLEL = 4;
export const PER_HOST_PER_WAVE = 2;
export const HOST_BACKOFF_MS = 60000;
export const HOST_BACKOFF_FIRST_MS = 15000;
export const HOST_TRIP_AFTER = 2;
export const PENDING_PER_CLINIC_MAX = 2000;
const CANDIDATES = 400;
const DOWN_PER_WAVE = 200;
const HOST_DOWN_ERRORS = new Set(['timeout', 'connect', 'tls', 'dns_failed', 'no_address', 'blocked_address']);

/** Хост адреса уведомления в нижнем регистре; негодный адрес — ''. */
export function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
}

/** Адрес для отдыха и очереди: «хост:порт» (https по умолчанию — 443); негодный адрес — ''. */
export function endpointOf(url) {
  try {
    const u = new URL(String(url));
    return u.hostname.toLowerCase() + ':' + (u.port || '443');
  } catch { return ''; }
}

/**
 * Отдых отказавших адресов. Адрес отдыхает после HOST_TRIP_AFTER неудач
 * соединения ПОДРЯД — случайный обрыв у живого партнёра (1 из 8) отдыха не
 * вызывает и пропускную способность не режет; отдых растёт 15 → 30 → 60 с
 * (HOST_BACKOFF_MS) и сбрасывается первым же ответом адреса (любой код).
 * Не больше max адресов в памяти.
 */
export function createHostBreaker({ tripAfter = HOST_TRIP_AFTER, firstMs = HOST_BACKOFF_FIRST_MS, backoffMs = HOST_BACKOFF_MS, max = 10000 } = {}) {
  const state = new Map();
  return {
    isDown: (key, now) => { const s = state.get(key); return !!s && s.until > now; },
    /** Конец отдыха адреса (мгновение) или null. */
    until: (key) => { const s = state.get(key); return s && s.until ? s.until : null; },
    /** Неудача соединения: после tripAfter подряд — отдых. */
    fail(key, now) {
      if (!key) return;
      const s = state.get(key) || { fails: 0, until: 0 };
      state.delete(key);
      if (state.size >= max) state.delete(state.keys().next().value);
      s.fails += 1;
      if (s.fails >= tripAfter) s.until = now + Math.min(backoffMs, firstMs * 2 ** (s.fails - tripAfter));
      state.set(key, s);
    },
    /** Адрес ответил — счёт неудач и отдых сброшены. */
    ok: (key) => { state.delete(key); },
    size: () => state.size,
  };
}
const processBreaker = createHostBreaker();

/** Сколько уведомлений клиники ждёт доставки (для потолка очереди при приёме событий). */
export function pendingCount(db, clinicId) {
  return db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE clinic_id = ? AND state = 'pending'").get(clinicId).n;
}

const logOf = (d, e) => ({ clinicId: d.clinic_id, deliveryId: d.id, connectionId: d.connection_id, requestId: d.request_id, eventId: d.event_id,
  event: d.event, ...e });

function record(db, d, r, now, out) {
  const at = isoOf(now);
  const born = msOf(d.created_at) ?? now;
  const deadline = born + DELIVERY_WINDOW_MS;
  // Адрес отдыхает: отсрочка до конца отдыха, попытка не тратится.
  if (r.error === 'host_down' && now < deadline) {
    const nextAt = isoOf(Math.max(now + 1000, Math.min(r.until || now + HOST_BACKOFF_MS, deadline)));
    db.transaction(() => {
      db.prepare('UPDATE deliveries SET next_at = ?, last_error = ?, updated_at = ? WHERE id = ?').run(nextAt, 'host_down', at, d.id);
      if (d.last_error !== 'host_down') {
        appendDeliveryLog(db, logOf(d, { attempt: d.attempts, code: null, error: 'host_down', at, nextAt, final: null }));
      }
    })();
    out.retrying += 1;
    return;
  }
  const sent = r.error !== 'host_down';
  const attempt = sent ? d.attempts + 1 : d.attempts;
  const ok = r.status >= 200 && r.status < 300;
  const final = ok ? 'delivered'
    : attempt >= MAX_ATTEMPTS || r.error === 'bad_url' || now >= deadline ? 'failed' : null;
  const nextAt = final ? null : isoOf(Math.max(now + 1000, Math.min(now + RETRY_MINUTES[attempt - 1] * 60000, deadline)));
  db.transaction(() => {
    db.prepare(`UPDATE deliveries SET attempts = ?, state = ?, next_at = ?, last_code = ?, last_error = ?, updated_at = ?,
                  body = CASE WHEN ? = 1 THEN NULL ELSE body END WHERE id = ?`)
      .run(attempt, final || 'pending', nextAt, r.status || null, r.error || null, at, final ? 1 : 0, d.id);
    appendDeliveryLog(db, logOf(d, { attempt, code: r.status || null, error: r.error || null, at, nextAt, final }));
  })();
  if (sent) out.attempts += 1;
  if (final === 'delivered') out.delivered += 1;
  else if (final === 'failed') out.failed += 1;
  else out.retrying += 1;
}

/**
 * Строки волны: по кругу пар «клиника — адрес», не больше perHost на адрес, не
 * больше limit. Строки отдыхающего адреса отправки не стоят — они идут сверх
 * limit (до DOWN_PER_WAVE) и откладываются до конца отдыха.
 */
function pickWave(db, now, limit, perHost, breaker) {
  const candidates = db.prepare(`SELECT id, url FROM (
                                   SELECT id, url, next_at, ROW_NUMBER() OVER (PARTITION BY clinic_id, url ORDER BY next_at, id) AS rn
                                   FROM deliveries WHERE state = 'pending' AND next_at <= ?)
                                 WHERE rn <= ? ORDER BY rn, next_at, id LIMIT ?`).all(isoOf(now), limit, CANDIDATES);
  const perHostCount = new Map();
  const ids = [];
  const down = [];
  for (const c of candidates) {
    const h = endpointOf(c.url);
    if (h && breaker.isDown(h, now)) { if (down.length < DOWN_PER_WAVE) down.push(c.id); continue; }
    const n = perHostCount.get(h) || 0;
    if (n >= perHost || ids.length >= limit) continue;
    perHostCount.set(h, n + 1);
    ids.push(c.id);
  }
  const get = db.prepare('SELECT * FROM deliveries WHERE id = ?');
  return [...ids, ...down].map((id) => get.get(id)).filter(Boolean);
}

/**
 * Одна волна доставки (честная очередь — см. начало файла). send({url, headers,
 * body}) → {status, error?} (lib/webhook-send.js makeSender в работе; в тестах —
 * подделка). breaker — отдых адресов между волнами (по умолчанию — один на процесс).
 * attempts — настоящие отправки; отложенные строки — в retrying.
 * @returns {Promise<{attempts:number, delivered:number, failed:number, retrying:number}>}
 */
export async function deliverDue(db, { now = Date.now(), send, limit = WAVE_LIMIT, parallel = PARALLEL, perHost = PER_HOST_PER_WAVE,
  breaker = processBreaker } = {}) {
  const wave = pickWave(db, now, limit, perHost, breaker).map((d) => ({ d, host: endpointOf(d.url) }));
  const out = { attempts: 0, delivered: 0, failed: 0, retrying: 0 };
  const one = async ({ d, host }) => {
    if (checkWebhookUrl(d.url)) return { status: 0, error: 'bad_url' };
    if (breaker.isDown(host, now)) return { status: 0, error: 'host_down', until: breaker.until(host) };
    let r;
    try {
      r = await send({ url: d.url, body: d.body || '', headers: {
        'Content-Type': 'application/json', 'X-EasyMed-Signature': d.signature, 'X-EasyMed-Event': d.event, 'X-EasyMed-Event-Id': d.event_id,
      } });
    } catch { r = null; }
    if (!r || typeof r !== 'object') return { status: 0, error: 'send_failed' };
    if (Number(r.status)) breaker.ok(host);
    else if (HOST_DOWN_ERRORS.has(r.error)) breaker.fail(host, now);
    // Ответ отправки — только код и вид ошибки: отсрочку «host_down» даёт лишь отдых.
    return { status: Number(r.status) || 0, ...(r.error && r.error !== 'host_down' ? { error: String(r.error) } : {}) };
  };
  // Непрерывный пул: до parallel отправок сразу, на один адрес — по одной.
  // Сбой записи в базу (база закрыта) — отказ всей волны, как раньше, а не
  // необработанное исключение: такт фона его ловит (jobs.js).
  await new Promise((resolve, reject) => {
    const busy = new Set();
    let active = 0;
    let failure = null;
    const pump = () => {
      if (failure) { if (!active) reject(failure); return; }
      if (!wave.length && !active) { resolve(); return; }
      while (active < parallel) {
        const i = wave.findIndex((w) => !busy.has(w.host));
        if (i < 0) break;
        const w = wave.splice(i, 1)[0];
        active += 1;
        busy.add(w.host);
        one(w).catch(() => ({ status: 0, error: 'send_failed' })).then((r) => {
          try { record(db, w.d, r, now, out); } catch (e) { failure = failure || e; }
          active -= 1;
          busy.delete(w.host);
          pump();
        });
      }
    };
    pump();
  });
  return out;
}

/** Уборка: законченные доставки старше 30 дней. */
export function purgeDeliveries(db, now) {
  return db.prepare("DELETE FROM deliveries WHERE state <> 'pending' AND updated_at < ?").run(isoOf(now - DELIVERY_KEEP_MS)).changes;
}
