// WEBSITE_V1 (задача W3) — маячок аналитики и движок сессий публичного
// сайта. Никаких персональных данных: сессия — случайный id в первосторонней
// куке, посетитель не идентифицируется. Чистая работа с БД, без Express —
// recordBeacon() тестируется напрямую (analytics.test.js); маршрут в app.js —
// тонкая обвязка сверху (куки, гарантированный ответ 204).
import crypto from 'node:crypto';
import { getSettings } from './content.js';

const MAX_TRACKED_IPS = 500; // тот же приём, что и у rate-limit.js
const SESSION_WINDOW_MS = 30 * 60 * 1000; // скользящее окно сессии — 30 минут

// Боты и служебные HTTP-клиенты — не посетители: их визиты не должны
// засорять сессии/просмотры аналитики. Список — частые UA поисковых роботов,
// генераторов превью соцсетей и скриптовых клиентов из логов публичных сайтов.
const BOT_RE = /bot|crawl|spider|slurp|mediapartners|facebookexternalhit|whatsapp|telegrambot|preview|headless|curl\/|wget\/|python-requests|python-urllib|okhttp|axios\/|go-http-client|libwww|scrapy/i;

const PAGE_TYPES = new Set([
  'home', 'doctors', 'doctor', 'services', 'service', 'departments',
  'department', 'about', 'contact', 'appointment', 'faq', 'news', 'post', 'legal', 'other',
]);

const LANGS = new Set(['uz', 'ru', 'en']);
const UTM_MAX = 100; // публичная незалогиненная запись — верхняя граница на всякий мусор
const REFERRER_HOST_MAX = 100; // Fix 4 — хост реферера тоже публичный ввод, режем как utm_*

// Формат id обеих кук (wsid/wvid) — 24 hex-символа, ровно то, что минтит
// crypto.randomBytes(12).toString('hex'). Куки, присланные браузером,
// ДОЛЖНЫ пройти эту проверку, прежде чем попасть хоть куда-то (в SQL или,
// тем более, эхом обратно в Set-Cookie) — иначе значение куки, полностью
// подконтрольное клиенту (например, `wvid=x; Domain=evil`, декодированное
// из query-encoded значения в parseCookies), можно использовать для
// инъекции произвольных атрибутов в заголовок ответа. Не проходит формат —
// трактуем как отсутствующую куку и минтим свежую.
const COOKIE_ID_RE = /^[0-9a-f]{24}$/;

// Fix 1 — сколько разных значений ключа допускается на одну пару
// (day, metric) в website_stats_daily, прежде чем новые ключи начнут
// сгребаться в сентинел '(other)'.
const MAX_STAT_KEYS = 500;

// strftime('%Y-%m-%dT%H:%M:%SZ','now') из миграций — без миллисекунд, чтобы
// строковое сравнение с колонками БД (first_seen/last_seen) было корректным.
function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Минимальный парсер куки — то же правило "последняя побеждает" (last-wins),
// что и у server/middleware/auth.js::parseCookies. Отдельная копия, а не
// импорт: у публичного сайта нет ЕРП-сессий, и тянуть middleware/auth.js
// сюда ради одной функции незачем (см. заголовок app.js — сайт НЕ должен
// зависеть от ЕРП-модулей).
export function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const raw = part.slice(i + 1).trim();
      try { out[part.slice(0, i).trim()] = decodeURIComponent(raw); }
      catch { out[part.slice(0, i).trim()] = raw; } // не декодируется — оставляем как есть
    }
  }
  return out;
}

// Хост реферера: пусто, если реферер отсутствует, не парсится как URL, или
// указывает на сам сайт — «пришёл сам с себя» не источник трафика.
// Два независимых сигнала «это мы»:
//  1. Host самого запроса (req.headers.host, порт отбрасывается) — работает
//     ВСЕГДА, даже когда settings.seo.base_url не настроен (значение по
//     умолчанию — пустая строка). Это основной сигнал: без него КАЖДАЯ
//     внутренняя навигация на дефолтной установке считалась бы внешним
//     переходом, что портит расчёт источников трафика (rollups фазы W3
//     задача 2 читают эти строки как есть).
//  2. settings.seo.base_url — второй сигнал для случая, когда сайт стоит
//     за отдельным публичным доменом, а Host запроса (например, за
//     обратным прокси/балансировщиком) может отличаться от него.
function refHost(ref, db, reqHost) {
  if (!ref) return '';
  let hostname;
  try { hostname = new URL(String(ref)).hostname.toLowerCase(); } catch { return ''; }
  if (reqHost) {
    const ownFromRequest = String(reqHost).split(':')[0].toLowerCase();
    if (hostname === ownFromRequest) return '';
  }
  let ownFromSettings = '';
  try {
    const baseUrl = getSettings(db).seo?.base_url;
    if (baseUrl) ownFromSettings = new URL(String(baseUrl)).hostname.toLowerCase();
  } catch { /* base_url не настроен или битый — не мешаем */ }
  return hostname && hostname !== ownFromSettings ? hostname : '';
}

function utmFromPath(path) {
  try {
    const q = new URL(String(path), 'http://x.invalid').searchParams;
    return {
      utm_source: (q.get('utm_source') || '').slice(0, UTM_MAX),
      utm_medium: (q.get('utm_medium') || '').slice(0, UTM_MAX),
      utm_campaign: (q.get('utm_campaign') || '').slice(0, UTM_MAX),
    };
  } catch {
    return { utm_source: '', utm_medium: '', utm_campaign: '' };
  }
}

function stripQuery(path) {
  const i = String(path).indexOf('?');
  return i === -1 ? path : path.slice(0, i);
}

// Суточные свёртки (website_stats_daily, миграция 083) — задача W3-3 читает
// эти метрики как есть, имена контрактные и менять их нельзя в одиночку.
// Апсерт всегда вызывается ИЗНУТРИ той же транзакции, что и породившая его
// запись (pageview/session/request) — счётчик и сырая строка либо оба
// применяются, либо оба откатываются.
export function bumpDailyStat(db, day, metric, key) {
  let k = key || '';
  // Fix 1 (анти-cardinality-DoS) — размеченные метрики (pageviews_by_path,
  // sessions_by_source, sessions_by_device) берут ключ из публичного ввода
  // (путь страницы, хост реферера) без ограничения на уникальность значений.
  // Без границы злоумышленник мог бы засыпать website_stats_daily
  // неограниченным числом строк — по строке на каждый выдуманный путь/хост, —
  // раздувая таблицу отчёта до неприемлемого размера. Метрики с key=''
  // (sessions, pageviews, sessions_returning) — не размеченные, им это не
  // грозит, проверка для них пропускается.
  if (k) {
    const already = db.prepare('SELECT 1 FROM website_stats_daily WHERE day=? AND metric=? AND key=?')
      .get(day, metric, k);
    if (!already) {
      const distinctKeys = db.prepare('SELECT COUNT(*) c FROM website_stats_daily WHERE day=? AND metric=?')
        .get(day, metric).c;
      if (distinctKeys >= MAX_STAT_KEYS) k = '(other)';
    }
  }
  db.prepare(`INSERT INTO website_stats_daily (day, metric, key, value) VALUES (?,?,?,1)
    ON CONFLICT(day, metric, key) DO UPDATE SET value = value + 1`).run(day, metric, k);
}

// recordBeacon() — единственная точка записи аналитики. Возвращает
// { wsid, wvid, isNew } при успехе, иначе null (маршрут в app.js всё равно
// всегда отвечает 204 — null просто значит «куки не выставляем»).
export function recordBeacon(db, body, meta) {
  const ua = String(meta?.ua || '');
  if (BOT_RE.test(ua)) return null;

  const path = typeof body?.path === 'string' ? body.path : '';
  if (!path.startsWith('/') || path.length > 300) return null;
  // Fix 3 — тот же query-stripped путь идёт И в просмотр, И в entry_path
  // сессии: раньше entry_path хранил path КАК ЕСТЬ, включая '?...', так что
  // туда же протекали произвольные query-параметры (например, чужой email
  // в хвосте utm-ссылки).
  const storedPath = stripQuery(path);

  const pageType = PAGE_TYPES.has(body?.page_type) ? body.page_type : 'other';
  const lang = LANGS.has(body?.lang) ? body.lang : '';
  const now = nowIso();
  const day = now.slice(0, 10);

  // Fix 2 — обе куки валидируются ОДНИМ и тем же форматом (см. COOKIE_ID_RE
  // выше), не проходит формат — трактуем как отсутствующую куку.
  const wvidIn = typeof meta?.wvid === 'string' && COOKIE_ID_RE.test(meta.wvid) ? meta.wvid : '';
  const wvid = wvidIn || crypto.randomBytes(12).toString('hex');

  // W3-2 — запись сессии/просмотра И их свёрток (website_stats_daily) —
  // одна транзакция: счётчики отчёта не должны разъезжаться с сырыми
  // строками, если что-то на середине упадёт (например, CHECK-констрейнт).
  const tx = db.transaction(() => {
    let sessionId = typeof meta?.wsid === 'string' && COOKIE_ID_RE.test(meta.wsid) ? meta.wsid : '';
    let isNew = false;
    if (sessionId) {
      const existing = db.prepare('SELECT last_seen FROM website_sessions WHERE id = ?').get(sessionId);
      if (existing && (Date.parse(now) - Date.parse(existing.last_seen)) <= SESSION_WINDOW_MS) {
        db.prepare('UPDATE website_sessions SET last_seen = ?, pageviews = pageviews + 1 WHERE id = ?')
          .run(now, sessionId);
      } else {
        sessionId = ''; // куки нет в базе или окно истекло — заводим новую сессию
      }
    }
    if (!sessionId) {
      sessionId = crypto.randomBytes(12).toString('hex');
      isNew = true;
      const utm = utmFromPath(path);
      const device = /mobile|android|iphone/i.test(ua) ? 'mobile' : 'desktop';
      // Fix 4 — хост реферера тоже публичный ввод (парсится из заголовка
      // Referer/поля body.ref, присланных клиентом): режем той же мерой,
      // что и utm_* (UTM_MAX), прежде чем он попадёт в сырую строку и в
      // свёртку sessions_by_source — без этого сколь угодно длинный hostname
      // раздувал бы обе таблицы.
      const referrerHost = refHost(body?.ref, db, meta?.host).slice(0, REFERRER_HOST_MAX);
      const isReturning = wvidIn ? 1 : 0;
      db.prepare(`INSERT INTO website_sessions
        (id, day, first_seen, last_seen, pageviews, entry_path, referrer_host,
         utm_source, utm_medium, utm_campaign, device, lang, is_returning)
        VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?)`).run(
        sessionId, day, now, now, storedPath, referrerHost,
        utm.utm_source, utm.utm_medium, utm.utm_campaign, device, lang, isReturning);

      // Новая сессия — счётчики "сколько сессий" считаются один раз на
      // сессию, а не на каждый просмотр внутри неё.
      bumpDailyStat(db, day, 'sessions', '');
      bumpDailyStat(db, day, 'sessions_by_source', referrerHost || 'direct');
      bumpDailyStat(db, day, 'sessions_by_device', device);
      if (isReturning) bumpDailyStat(db, day, 'sessions_returning', '');
    }

    db.prepare('INSERT INTO website_pageviews (session_id, path, page_type) VALUES (?,?,?)')
      .run(sessionId, storedPath, pageType);
    // Каждый принятый просмотр — независимо от того, новая сессия или нет.
    bumpDailyStat(db, day, 'pageviews', '');
    bumpDailyStat(db, day, 'pageviews_by_path', storedPath);

    return { wsid: sessionId, wvid, isNew };
  });

  return tx();
}

const RETENTION_MIN_DAYS = 7;
const RETENTION_DEFAULT_DAYS = 90;

function isoAt(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// pruneWebsiteAnalytics() — чистка сырых данных (сессии/просмотры) по сроку
// хранения из настроек; суточные свёртки (website_stats_daily) НЕ трогаются
// никогда — они и есть тот отчёт, ради которого сырые данные можно стирать.
// Сначала удаляются просмотры старше среза, затем сессии старше среза, у
// которых не осталось ни одного просмотра (NOT EXISTS) — сессия с недавним
// просмотром переживёт срез по last_seen, если этот просмотр моложе.
export function pruneWebsiteAnalytics(db) {
  const settings = getSettings(db);
  const configured = Number(settings.analytics?.retention_days);
  const retentionDays = Math.max(RETENTION_MIN_DAYS,
    Number.isFinite(configured) && configured > 0 ? configured : RETENTION_DEFAULT_DAYS);
  const cutoff = isoAt(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const tx = db.transaction(() => {
    const pv = db.prepare('DELETE FROM website_pageviews WHERE created_at < ?').run(cutoff);
    const ss = db.prepare(`DELETE FROM website_sessions WHERE last_seen < ? AND NOT EXISTS
      (SELECT 1 FROM website_pageviews WHERE website_pageviews.session_id = website_sessions.id)`).run(cutoff);
    return { pageviews: pv.changes, sessions: ss.changes };
  });
  return tx();
}

// Троттлинг маячка — то же скользящее окно на IP, что и rate-limit.js
// (server/site/rate-limit.js), но с другим ответом при превышении: правило
// W3-R3 требует, чтобы /api/beacon ВСЕГДА отвечал 204 (аналитика никогда не
// мешает сайту — раздражающий 429 в devtools того не стоит). Поэтому лимит
// сам закрывает ответ 204 и не вызывает next() — до записи в БД (express.json
// + recordBeacon) пайплайн в этом случае просто не доходит.
export function beaconLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> { count, windowStart }
  return function (req, res, next) {
    const ip = req.ip || '';
    const now = Date.now();
    const e = hits.get(ip) || { count: 0, windowStart: now };
    if (now - e.windowStart > windowMs) { e.count = 0; e.windowStart = now; }
    e.count += 1;
    hits.delete(ip);
    hits.set(ip, e);
    if (hits.size > MAX_TRACKED_IPS) {
      for (const [k, v] of hits) {
        if (hits.size <= MAX_TRACKED_IPS) break;
        if (now - v.windowStart > windowMs) hits.delete(k);
      }
    }
    if (e.count > max) {
      res.status(204).end();
      return;
    }
    next();
  };
}
