// TELEPHONY_V1 — RPC раздела «Телефония» в настройках.
//
// Why RPC and not /api/db: telephony_settings is deliberately NOT registered
// in schema-registry.js, so the secret is unreachable through the query
// endpoint by construction (telegram_settings' own rule, same reasoning).
// Nothing returned here ever contains api_secret — only api_secret_set.

import { hasAnyRole } from '../roles.js';
import { publicSettings, saveSettings, getCredentials, SettingsError } from '../telephony/settings.js';
import { binotelCall } from '../telephony/binotel.js';
import { wakePolling } from '../telephony/poller.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// The credentials open the clinic's whole call history at Binotel, so the
// section is admin-only in full, reads included — the telegram-token rule.
// hasAnyRole, not user.role: an admin whose PRIMARY role is doctor
// (ADMIN_DOCTOR_V1) must not be locked out of a settings screen.
function requireAdmin(user) {
  if (!hasAnyRole(user, ['admin'])) {
    throw new RpcError('Настройки телефонии доступны только администратору.', 403);
  }
}

export function telephonySettingsGet(db, _args, user) {
  requireAdmin(user);
  return publicSettings(db);
}

export function telephonySettingsSave(db, args, user) {
  requireAdmin(user);
  let out;
  try {
    out = saveSettings(db, args || {}, user && user.id ? user.id : null);
  } catch (e) {
    if (e instanceof SettingsError) throw new RpcError(e.message, e.status);
    throw e;
  }
  // The poller re-reads settings every tick anyway; waking it makes «включить»
  // act in seconds instead of at the end of the previous interval —
  // wakeTelegramBot's reasoning, applied here.
  wakePolling();
  return out;
}

// binotel.js's fixed reason vocabulary mapped onto the sentences the screen
// shows verbatim (ENROLL_MESSAGES' pattern in licence.js). One sentence per
// DISTINCT next action the admin could take; server_error and bad_response
// share the admin's remedy ("later") but are kept apart so support can tell
// "Binotel is down" from "Binotel changed its answers".
const TEST_MESSAGES = {
  bad_credentials: 'Ключ или секрет не подходят. Проверьте данные, выданные Binotel.',
  offline:         'Нет связи с Binotel. Проверьте интернет на этом компьютере.',
  server_error:    'Binotel ответил ошибкой. Попробуйте позже.',
  bad_response:    'Ответ Binotel не удалось разобрать. Попробуйте позже.',
};

/**
 * «Проверить подключение». Uses the just-typed credentials when the fields
 * are filled, the SAVED ones otherwise — so the button can prove a new pair
 * BEFORE the admin saves it over a working one. Async: routes/rpc.js has
 * awaited handlers since telegram_test_connection. binotelCallImpl is the
 * test seam — the RPC signature is (db, args, user), so the transport cannot
 * be injected any other way (licenceEnroll's pattern).
 */
export async function telephonyTest(db, args, user, { binotelCallImpl = binotelCall } = {}) {
  requireAdmin(user);
  const saved = getCredentials(db);
  const typed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const key = typed(args && args.api_key) || saved.key;
  const secret = typed(args && args.api_secret) || saved.secret;
  if (!key || !secret) {
    return { ok: false, reason: 'bad_credentials', message: TEST_MESSAGES.bad_credentials };
  }

  // The cheapest question Binotel answers with these credentials: calls of
  // the last minute. The content is irrelevant — only whether the key/secret
  // opened the door.
  const r = await binotelCallImpl('stats/all-incoming-calls-since',
    { timestamp: Math.floor(Date.now() / 1000) - 60 }, { key, secret });
  if (!r.ok) return { ok: false, reason: r.reason, message: TEST_MESSAGES[r.reason] || TEST_MESSAGES.server_error };
  return { ok: true };
}

// Last 20 by call time — the settings screen's proof-of-life list. `raw`
// stays server-side on purpose: it is vendor diagnostics, not something to
// ship to a browser with every refresh.
export function telephonyRecentCalls(db, _args, user) {
  requireAdmin(user);
  return db.prepare(`
    SELECT c.id, c.general_call_id, c.started_at, c.call_type, c.external_number,
           c.internal_number, c.waitsec, c.billsec, c.disposition, c.is_new_call,
           c.patient_id, p.full_name AS patient_name, c.source
      FROM calls c
      LEFT JOIN patients p ON p.id = c.patient_id
     ORDER BY c.started_at DESC, c.id DESC
     LIMIT 20`).all();
}
