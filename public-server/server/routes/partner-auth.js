// PUBLIC_SERVER_V1 — ВХОД ПАРТНЁРА: клиника по имени в адресе, её состояние,
// ключ, права, IP, сайт (CORS), лимиты, журнал запросов.
//
// Порядок — от дешёвого к дорогому и от общего к частному:
//   1. общий потолок по IP — до всего (перебор имён и ключей, поток мусора);
//   2. клиника по имени в адресе (прежнее имя — 30 дней) — иначе 404;
//   3. только https (за nginx — X-Forwarded-Proto, PUBLIC_TRUST_PROXY);
//   4. клиника доступна: лицензия не истекла и не «не оплачено» (решения 4 и
//      17) — иначе 503 licence_lapsed; клиника не выходила на связь 7 суток —
//      503 clinic_offline (выключенный в ней ключ мог бы работать по старым
//      правам — дизайн §2, смягчение «б»). Текст — «временно недоступна», не
//      «не оплатила» (правило easymed-licence-lockout); телефон клиники — в ответе;
//   5. ключ: SHA-256 от Bearer ищется среди отпечатков клиники (решение 5 —
//      самого ключа сервер не знает); выключен / истёк — 401 со своим кодом;
//      неверные ключи с одного IP — не больше 30 в минуту;
//   6. «Разрешённые IP» подключения — 403; сайт (Origin) не из адресов
//      подключения — 403 (браузер с чужого сайта не пошлёт запрос с ключом);
//   7. лимит ключа в минуту (rate_limit подключения) и записи — не больше 30 в
//      минуту — 429 с Retry-After;
//   8. права раздела — 403 forbidden_scope.
// Журнал запросов (30 дней): путь — по списку известных адресов, параметры — по
// списку и по виду значения; присланного сверх этого в журнал не попадает.
// Что вообще становится строкой (429 — нет, без ключа — только 401, потолки в
// сутки и всего) — store/access-journal.js (проверка 8b, C6).
import { KEY_RE, normalizeSlug } from '../../../public/js/shared/api-connections.js';
import { API_GROUPS } from '../../../public/js/shared/service-public.js';
import { GEO_REGION_CODES, GEO_DISTRICT_CODES } from '../../../public/js/shared/geo-codes.js';
import { SPECIALTY_ROWS } from '../../../public/js/shared/specialty-list.js';
import { keyHash } from '../../../server/services/api/secret-box.js';
import { resolveSlug, connectionByHash, originAllowedForClinic, markUsed, snapshotOf } from '../store/clinics.js';
import { recordAccess } from '../store/logs.js';
import { createAccessJournal } from '../store/access-journal.js';
import { licenceStanding } from '../licence-gate.js';
import { feedBlocksClinic, feedRevokedPartnerKey } from '../store/feed.js';
import { ipAllowed, clientIp } from '../lib/net-guard.js';
import { sendError } from '../lib/errors.js';
import { isoOf, msOf } from '../lib/time.js';

export const IP_LIMIT_PER_MIN = 1200;
export const AUTH_FAIL_LIMIT_PER_MIN = 30;
export const WRITE_LIMIT_PER_MIN = 30;
export const CLINIC_SILENT_MAX_MS = 7 * 86400000;

const RQ = 'rq_[A-Za-z0-9]{6,37}';
const KNOWN_PATHS = [
  /^\/(clinic|branches|doctors|services|packages|slots|requests|appointments)$/,
  /^\/reference\/(geo|specialties)$/,
  new RegExp(`^\\/requests\\/${RQ}$`),
  new RegExp(`^\\/appointments\\/${RQ}(\\/(accept|decline))?$`),
];
// Город, район, специальность — только коды справочников программы: вид
// [a-z0-9-] пропустил бы в журнал и телефон, вписанный в фильтр (сборщик Б,
// усиление сверх плана).
const listed = (codes) => { const set = new Set(codes); return { test: (v) => set.has(v) }; };
const QUERY_RULES = {
  lang: /^(ru|uz|en)$/, doctor_id: /^\d{1,9}$/, service_id: /^\d{1,9}$/, branch_id: /^\d{1,9}$/, date: /^\d{4}-\d{2}-\d{2}$/,
  consultation: /^(initial|repeat)$/, group: new RegExp('^(' + API_GROUPS.join('|') + ')$'), specialty: listed(SPECIALTY_ROWS.map((r) => r.slug)),
  district: listed(GEO_DISTRICT_CODES), city: listed(GEO_REGION_CODES),
};

/** Путь для журнала: известный адрес — как есть, иначе «/?»; параметры — только известные и только верного вида. */
export function logPath(slug, req) {
  const p = String(req.path || '');
  const known = KNOWN_PATHS.some((re) => re.test(p)) ? p : '/?';
  const q = Object.entries(QUERY_RULES)
    .filter(([k, re]) => typeof req.query[k] === 'string' && re.test(req.query[k]))
    .map(([k]) => k + '=' + req.query[k]);
  return '/' + slug + '/v1' + known + (q.length ? '?' + q.join('&') : '');
}

// CORS (проверка 8b, C12): Retry-After — не «простой» заголовок ответа, без
// Access-Control-Expose-Headers скрипт сайта его не прочтёт. 429 потолка по IP
// отвечает ДО поиска клиники (иначе перебор имён шёл бы без лимита), поэтому
// сайт на нём узнаётся только по памяти: этому сайту по этому имени уже
// отвечали с CORS за последние CORS_SEEN_MS. Новое имя или чужой сайт — без
// CORS: перебор имён по заголовкам ничего не узнаёт.
export const CORS_SEEN_MS = 10 * 60000;
const CORS_SEEN_MAX = 5000;
function corsHeaders(res, origin) {
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Expose-Headers', 'Retry-After');
  res.set('Vary', 'Origin');
}
function seenOrigins() {
  const seen = new Map();
  return {
    has: (k, now) => (seen.get(k) || 0) > now,
    add(k, now) {
      seen.delete(k);
      if (seen.size >= CORS_SEEN_MAX) seen.delete(seen.keys().next().value);
      seen.set(k, now + CORS_SEEN_MS);
    },
  };
}

const phoneOf = (clinic) => { const s = snapshotOf(clinic); return String((s && s.clinic && s.clinic.phone) || ''); };

/** Потолок по IP, клиника по имени в адресе, https, состояние клиники, журнал запросов. */
export function clinicGate(ctx) {
  // Один на приложение: счётчики пропущенного — для наблюдения (ctx.accessJournal.stats()).
  const journal = ctx.accessJournal || (ctx.accessJournal = createAccessJournal());
  const corsSeen = seenOrigins();
  return (req, res, next) => {
    const now = ctx.now();
    req.ipAddr = clientIp(req.ip);
    const origin = req.get('origin');
    const seenKey = normalizeSlug(req.params.slug) + ' ' + origin;
    // Потолок — до поиска клиники: перебор имён в адресе тоже упирается в лимит.
    if (ctx.limiter) {
      const hit = ctx.limiter.hit('ip:' + req.ipAddr, IP_LIMIT_PER_MIN, now);
      if (!hit.ok) {
        if (origin && corsSeen.has(seenKey, now)) corsHeaders(res, origin);
        return sendError(req, res, 'rate_limited', {}, { 'Retry-After': hit.retryAfterSec });
      }
    }
    const clinic = resolveSlug(ctx.db, req.params.slug, now);
    if (!clinic) return sendError(req, res, 'clinic_not_found');
    req.clinic = clinic;
    if (origin && originAllowedForClinic(ctx.db, clinic.clinic_id, origin)) {
      corsHeaders(res, origin);
      corsSeen.add(seenKey, now);
    }
    if (req.method !== 'OPTIONS' && !/^\/media\//.test(req.path)) {
      const t0 = Date.now();
      const path = logPath(clinic.slug, req);   // сейчас, пока путь — внутри маршрутизатора
      res.on('finish', () => {
        try {
          const connectionId = req.conn ? req.conn.id : null;
          const at = ctx.now();
          if (!journal.admit(ctx.db, { clinicId: clinic.clinic_id, connectionId, status: res.statusCode, now: at })) return;
          recordAccess(ctx.db, { clinicId: clinic.clinic_id, connectionId, at: isoOf(at),
            method: req.method, path, status: res.statusCode, ip: req.ipAddr, ms: Date.now() - t0 });
        } catch { /* журнал не роняет ответ */ }
      });
    }
    if (ctx.requireHttps && !req.secure) return sendError(req, res, 'https_required');
    // PUBLIC_LICENCE_V1 — и по списку производителя (store/feed.js): не оплачено,
    // выключено, снята, ключ обмена отозван — даже если клиника без связи и
    // предъявила бы старую лицензию. Ответ тот же: «временно недоступна».
    if (licenceStanding(clinic, now) !== 'active' || feedBlocksClinic(ctx.feed, clinic)) {
      return sendError(req, res, 'licence_lapsed', { phone: phoneOf(clinic) });
    }
    if (now - (msOf(clinic.last_seen_at) || 0) > CLINIC_SILENT_MAX_MS) return sendError(req, res, 'clinic_offline', { phone: phoneOf(clinic) });
    return next();
  };
}

/** Предварительный запрос браузера (CORS): ключа в нём нет — сайт должен быть у одного из включённых подключений клиники. */
export function preflight(ctx) {
  return (req, res, next) => {
    if (req.method !== 'OPTIONS') return next();
    const origin = req.get('origin');
    if (!origin || !originAllowedForClinic(ctx.db, req.clinic.clinic_id, origin)) return sendError(req, res, 'origin_not_allowed');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Max-Age', '600');
    return res.status(204).end();
  };
}

/** Ключ, IP, сайт, лимиты. */
export function requireKey(ctx) {
  return (req, res, next) => {
    const now = ctx.now();
    const clinic = req.clinic;
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || ''));
    const key = m ? m[1] : '';
    const conn = KEY_RE.test(key) ? connectionByHash(ctx.db, clinic.clinic_id, keyHash(key)) : null;
    if (!conn) {
      if (ctx.limiter) {
        const hit = ctx.limiter.hit('authfail:' + req.ipAddr, AUTH_FAIL_LIMIT_PER_MIN, now);
        if (!hit.ok) return sendError(req, res, 'rate_limited', {}, { 'Retry-After': hit.retryAfterSec });
      }
      return sendError(req, res, 'invalid_key');
    }
    req.conn = conn;
    // PUBLIC_LICENCE_V1 — срочный отзыв из панели производителя (store/feed.js):
    // ключ выключен, что бы ни присылала клиника в PUT /keys.
    if (!conn.active || feedRevokedPartnerKey(ctx.feed, conn.key_hash)) return sendError(req, res, 'key_disabled');
    if (conn.key_expires_at && (msOf(conn.key_expires_at) || 0) <= now) return sendError(req, res, 'key_expired');
    if (!ipAllowed(conn.ip_allow, req.ipAddr)) return sendError(req, res, 'ip_not_allowed');
    const origin = req.get('origin');
    if (origin && !conn.origins.includes(String(origin).toLowerCase())) return sendError(req, res, 'origin_not_allowed');
    if (ctx.limiter) {
      const hit = ctx.limiter.hit('key:' + clinic.clinic_id + ':' + conn.id, conn.rate_limit, now);
      if (!hit.ok) return sendError(req, res, 'rate_limited', {}, { 'Retry-After': hit.retryAfterSec });
      if (req.method === 'POST' || req.method === 'DELETE') {
        const w = ctx.limiter.hit('write:' + clinic.clinic_id + ':' + conn.id, WRITE_LIMIT_PER_MIN, now);
        if (!w.ok) return sendError(req, res, 'rate_limited', {}, { 'Retry-After': w.retryAfterSec });
      }
    }
    markUsed(ctx.db, clinic.clinic_id, conn.id, now);
    return next();
  };
}

/** Права раздела: хоть одно из названных. */
export const scope = (...names) => (req, res, next) =>
  (names.some((n) => req.conn.scopes.includes(n)) ? next() : sendError(req, res, 'forbidden_scope', { scope: names[0] }));
