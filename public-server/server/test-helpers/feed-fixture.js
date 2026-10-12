// PUBLIC_LICENCE_V1 — стенд тестов: список производителя, подписанный тестовым
// «производителем» (пара из fixture.js testVendor) — так его подписывает сервер
// лицензий (control-plane/server/services/signing.js signFeed).
import crypto from 'node:crypto';
import { feedMessage, makeFeedPayload } from '../../../server/services/control/vendor-feed.js';

/** @returns {string} тело ответа GET /cp/v1/public-feed */
export function signTestFeed(vendor, { issuedAt, clinicsOff = [], syncKeysRevoked = [], partnerKeysRevoked = [] }) {
  const payload = makeFeedPayload({ issuedAt, clinicsOff, syncKeysRevoked, partnerKeysRevoked });
  return JSON.stringify({ payload, sig: crypto.sign(null, feedMessage(payload), vendor.privateKey).toString('base64') });
}
