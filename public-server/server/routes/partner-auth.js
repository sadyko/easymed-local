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
import { KEY_RE } from '../../../public/js/shared/api-connections.js';
import { API_GROUPS } from '../../../public/js/shared/service-public.js';
import { keyHash } from '../../../server/services/api/secret-box.js';
import { resolveSlug, connectionByHash, originAllowedForClinic, markUsed, snapshotOf } from '../store/clinics.js';
import { recordAccess } from '../store/logs.js';
import { licenceStanding } from '../licence-gate.js';
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
const QUERY_RULES = {
  lang: /^(ru|uz|en)$/, doctor_id: /^\d{1,9}$/, service_id: /^\d{1,9}$/, branch_id: /^\d{1,9}$/, date: /^\d{4}-\d{2}-\d{2}$/,
  consultation: /^(initial|repeat)$/, group: new RegExp('^(' + API_GROUPS.join('|') + ')$'), specialty: /^[a-z0-9-]{1,60}$/,
  district: /^[a-z0-9-]{1,60}$/, city: /^[a-z0-9-]{1,60}$/,
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

const phoneOf = (clinic) => { const s = snapshotOf(clinic); return String((s && s.clinic && s.clinic.phone) || ''); };

/** Потолок по IP, клиника по имени в адресе, https, состояние клиники, журнал запросов. */
export function clinicGate(ctx) {
  return (req, res, next) => {
    const now = ctx.now();
    req.ipAddr = clientIp(req.ip);
    // Потолок — до поиска клиники: перебор имён в адресе тоже упирается в лимит.
    if (ctx.limiter) {
      const hit = ctx.limiter.hit('ip:' + req.ipAddr, IP_LIMIT_PER_MIN, now);
      if (!hit.ok) return sendError(req, res, 'rate_limited', {}, { 'Retry-After': hit.retryAfterSec });
    }
    const clinic = resolveSlug(ctx.db, req.params.slug, now);
    if (!clinic) return sendError(req, res, 'clinic_not_found');
    req.clinic = clinic;
    const origin = req.get('origin');
    if (origin && originAllowedForClinic(ctx.db, clinic.clinic_id, origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    if (req.method !== 'OPTIONS' && !/^\/media\//.test(req.path)) {
      const t0 = Date.now();
      const path = logPath(clinic.slug, req);   // сейчас, пока путь — внутри маршрутизатора
      res.on('finish', () => {
        try {
          recordAccess(ctx.db, { clinicId: clinic.clinic_id, connectionId: req.conn ? req.conn.id : null, at: isoOf(ctx.now()),
            method: req.method, path, status: res.statusCode, ip: req.ipAddr, ms: Date.now() - t0 });
        } catch { /* журнал не роняет ответ */ }
      });
    }
    if (ctx.requireHttps && !req.secure) return sendError(req, res, 'https_required');
    if (licenceStanding(clinic, now) !== 'active') return sendError(req, res, 'licence_lapsed', { phone: phoneOf(clinic) });
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
    if (!conn.active) return sendError(req, res, 'key_disabled');
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
