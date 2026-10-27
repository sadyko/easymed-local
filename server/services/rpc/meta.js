// META_LEADS_V1 — RPC раздела «Meta: заявки из рекламы» (Настройки →
// «Коммерческие инструменты»).
//
// Why RPC and not /api/db: meta_settings намеренно НЕ заведена в
// schema-registry.js, поэтому до шифртекста токена через запросный эндпоинт
// не добраться по построению (правило telegram_settings и telephony_settings).
// Ничто из возвращаемого здесь не содержит токена — только token_set и хвост,
// и хвост — только администратору.
//
// Раздел выдаётся из «Ролей» ключом settings.meta: «Просмотр» — настройки и
// журнал заявок, «Изменение» — токен, формы, включение и опрос сейчас. Роль,
// которая ключ не настраивала, — только администратор (с учётом надстроечных
// ролей, ADMIN_DOCTOR_V1): токен Meta — доступ к заявкам всей страницы.

import { grantAllowsAdminOr, isAdminUser } from '../grants.js';
import { publicSettings, saveSettings, clearToken, rewindSince, SettingsError } from '../meta/settings.js';
import { connect } from '../meta/connect.js';
import { pollOnce, wakePolling } from '../meta/poller.js';
import { SecretBoxError } from '../api/secret-box.js';
import { metaReasonText } from '../../../public/js/shared/meta-reasons.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const META_KEY = 'settings.meta';
function requireLevel(db, user, need) {
  if (!grantAllowsAdminOr(db, user, META_KEY, need)) {
    throw new RpcError('Настройки Meta недоступны вашей роли. Права выдаёт администратор в «Настройки → Роли».', 403);
  }
}

// Хвост токена — тоже подсказка о токене: не-администратору не показывается.
function maskedFor(user, settings) {
  if (isAdminUser(user)) return settings;
  return { ...settings, token_tail: '', secrets_hidden: true };
}

function rethrow(e) {
  if (e instanceof SettingsError) throw new RpcError(e.message, e.status);
  if (e instanceof SecretBoxError) throw new RpcError(e.message, e.status || 409);
  throw e;
}

export function metaSettingsGet(db, _args, user) {
  requireLevel(db, user, 'view');
  return maskedFor(user, publicSettings(db));
}

export function metaSettingsSave(db, args, user) {
  requireLevel(db, user, 'edit');
  let out;
  try { out = saveSettings(db, args || {}, user && user.id ? user.id : null); }
  catch (e) { rethrow(e); }
  // «Включить» начинает опрос через секунды, а не через период.
  wakePolling();
  return maskedFor(user, out);
}

/**
 * meta_connect({ token?, page_id? }) — проверить токен (новый или сохранённый)
 * и привязать страницу. Отказ Meta — ok:false с причиной и фразой, НЕ исключение:
 * прежнее подключение остаётся, экран показывает, что не так.
 */
export async function metaConnect(db, args, user, deps = {}) {
  requireLevel(db, user, 'edit');
  const a = args || {};
  const token = typeof a.token === 'string' ? a.token.trim() : '';
  if (!token && !publicSettings(db).token_set) throw new RpcError('Введите токен доступа Meta.', 400);
  let r;
  try { r = await connect(db, { token, pageId: a.page_id != null ? String(a.page_id) : '' }, deps); }
  catch (e) { rethrow(e); }
  const settings = maskedFor(user, publicSettings(db));
  if (!r.ok) {
    const detail = r.message ? ` (${r.message})` : '';
    return { ok: false, reason: r.reason, message: metaReasonText(r.reason) + detail, settings };
  }
  wakePolling();
  return { ok: true, me: r.me, page: r.page, pages: r.pages, forms: r.forms, settings };
}

export function metaTokenClear(db, _args, user) {
  requireLevel(db, user, 'edit');
  return maskedFor(user, clearToken(db, user && user.id ? user.id : null));
}

function journalCounts(db) {
  const o = { created: 0, merged: 0, error: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM meta_leads GROUP BY status').all()) o[r.status] = Number(r.n) || 0;
  return o;
}

/**
 * meta_poll_now({ days? }) — один проход сейчас; days сдвигает курсор назад
 * («забрать заявки за последние N дней»). Ответ — настройки после прохода и
 * сколько заявок он принёс. Выключенная интеграция прохода не делает.
 */
export async function metaPollNow(db, args, user, deps = {}) {
  requireLevel(db, user, 'edit');
  const a = args || {};
  if (a.days != null && a.days !== '') {
    try { rewindSince(db, a.days); } catch (e) { rethrow(e); }
  }
  const before = journalCounts(db);
  if (publicSettings(db).enabled) await pollOnce(db, deps);
  const after = journalCounts(db);
  return {
    settings: maskedFor(user, publicSettings(db)),
    created: after.created - before.created,
    merged: after.merged - before.merged,
    errors: after.error - before.error,
  };
}

/** meta_leads_recent({ limit }) — журнал полученных заявок, новые вперёд, с этапом карточки CRM. */
export function metaLeadsRecent(db, args, user) {
  requireLevel(db, user, 'view');
  const lim = Math.min(200, Math.max(1, Number((args || {}).limit) || 50));
  return db.prepare(`
    SELECT m.id, m.leadgen_id, m.form_name, m.platform, m.campaign_name, m.ad_name, m.created_time, m.received_at,
           m.full_name, m.phone, m.email, m.status, m.error, m.crm_request_id,
           COALESCE(s.label, '') AS crm_stage_label
      FROM meta_leads m
      LEFT JOIN crm_requests r ON r.id = m.crm_request_id
      LEFT JOIN crm_stages s ON s.key = r.status
     ORDER BY m.received_at DESC, m.id DESC
     LIMIT ?`).all(lim);
}
