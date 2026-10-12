// PUBLIC_LICENCE_V1 — GET /cp/v1/public-feed: подписанный список производителя
// для публичного сервера api.easymed.uz (server/services/control/vendor-feed.js).
//
// Публичный сервер забирает его сам, раз в минуту (public-server/server/jobs.js),
// с токеном EASYMED_CP_FEED_TOKEN — тем же, что у него в PUBLIC_FEED_TOKEN. Так
// решение в панели («не оплачено», «онлайн-запись выключена», «заблокировать
// ключ») доходит до партнёров за минуту — даже если клиника без связи или её
// программа подменена: лицензию несёт клиника, этот список — производитель.
//
// Что в нём (только номера клиник и отпечатки ключей — ни имён, ни данных
// пациентов; страж server/services/api/no-patient-data-to-vendor.test.js):
//   clinics_off — каждая клиника реестра, которую партнёры видеть не должны
//                 (services/public-api.js partnersSee ≠ 'visible'), и каждая
//                 удалённая (deleted_clinics) — её последняя лицензия может
//                 быть ещё жива;
//   sync_keys_revoked, partner_keys_revoked — действующие записи revocations.
//
// Подписывается при каждом запросе: issued_at — «сейчас», по нему публичный
// сервер видит, насколько свеж его список (/_metrics feed_age_s), и не берёт
// список старше уже принятого.
//
// Без токена в окружении (или короче 32 знаков) адреса нет — 404, как у
// /cp/v1/deploy. Неверный токен — 401. Тела у запроса нет.
import { Router } from 'express';
import { bearerToken, tokenMatches, MIN_TOKEN_CHARS } from './deploy.js';
import { signFeed } from '../services/signing.js';
import { isEntitled } from '../services/checkin.js';
import { partnersSee } from '../services/public-api.js';
import { makeFeedPayload } from '../../../server/services/control/vendor-feed.js';

export const PUBLIC_FEED_MOUNT = '/cp/v1/public-feed';
const NOT_FOUND_BODY = { error: { code: 'not_found', message: 'Unknown API endpoint.' } };

/** Полезная часть списка — из реестра, на миг now. */
export function buildFeedPayload(db, now = new Date()) {
  const clinicsOff = db.prepare(
    'SELECT clinic_id, active, subscription, subscription_until, api_enabled, api_sync_key FROM clinics',
  ).all()
    .filter((c) => partnersSee(c, { entitled: isEntitled(c.subscription, c.subscription_until, now) }) !== 'visible')
    .map((c) => c.clinic_id)
    .concat(db.prepare('SELECT clinic_id FROM deleted_clinics').all().map((r) => r.clinic_id));
  const live = (kind) => db.prepare('SELECT value FROM revocations WHERE kind = ? AND removed_at IS NULL').all(kind).map((r) => r.value);
  return makeFeedPayload({
    issuedAt: now.toISOString(),
    clinicsOff,
    syncKeysRevoked: live('sync_key'),
    partnerKeysRevoked: live('partner_key'),
  });
}

function configuredToken(env) {
  const raw = String(env.EASYMED_CP_FEED_TOKEN || '').trim();
  return raw.length >= MIN_TOKEN_CHARS ? raw : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{env?:object, now?:()=>Date}} [opts]
 */
export function publicFeedRoutes(db, { env = process.env, now = () => new Date() } = {}) {
  const r = Router();
  const token = configuredToken(env);
  if (!token && String(env.EASYMED_CP_FEED_TOKEN || '').trim()) {
    console.error(`[control-plane] EASYMED_CP_FEED_TOKEN is shorter than ${MIN_TOKEN_CHARS} characters and is being IGNORED — ${PUBLIC_FEED_MOUNT} will answer 404 and the public server cannot learn about unpaid clinics or revoked keys.`);
  }
  r.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!token) return res.status(404).json(NOT_FOUND_BODY);
    if (!tokenMatches(bearerToken(req.headers.authorization), token)) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'A valid feed token is required.' } });
    }
    return next();
  });
  r.get('/', (req, res) => res.json(signFeed(buildFeedPayload(db, now()))));
  r.use((req, res) => res.status(404).json(NOT_FOUND_BODY));
  return r;
}
