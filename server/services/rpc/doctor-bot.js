// REFERRALS_CRM_V1 (2026-10-26) — RPC вкладки «Реферирование → Telegram-бот»:
// настройки бота для врачей-источников, проверка связи, охват, подключённые.
// Всё — только администратору клиники (как токен пациентского бота): токен
// открывает переписку с врачами, а список подключённых — их телефоны.
import { isAdminUser } from '../grants.js';
import { getMe, TelegramError } from '../telegram/api.js';
import { publicSettings, saveSettings, clearToken, getDecryptedToken, recordCheck, SettingsError } from '../doctor-bot/settings.js';
import { wakeDoctorBot } from '../doctor-bot/index.js';

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function requireAdmin(user) {
  if (isAdminUser(user)) return;
  throw new RpcError('Бот для врачей-источников настраивает администратор клиники.', 403);
}
function rethrow(e) {
  if (e instanceof SettingsError) throw new RpcError(e.message, e.status);
  throw e;
}

export function doctorBotSettingsGet(db, _args, user) {
  requireAdmin(user);
  return publicSettings(db);
}

/**
 * Сохранить токен и/или выключатель. Новый токен сразу проверяется у Telegram:
 * имя бота — на экран, ошибка — тоже; удачно проверенный токен включает бота
 * сам (auto_enabled), как у пациентского бота — владелец вставил токен и ждёт,
 * что бот заработал, а не второй галочки.
 */
export async function doctorBotSettingsSave(db, args, user, deps = {}) {
  requireAdmin(user);
  const uid = user && user.id ? user.id : null;
  let settings;
  try { settings = saveSettings(db, args || {}, uid); } catch (e) { return rethrow(e); }

  const tokenAdded = args && args.bot_token && String(args.bot_token).trim() !== '';
  if (!tokenAdded) { wakeDoctorBot(); return settings; }

  let token;
  try { token = getDecryptedToken(db); } catch (e) { return { ...settings, check_error: 'Сохранённый токен не читается: ' + e.message }; }
  try {
    const me = await getMe(token, deps);
    let out = recordCheck(db, { ok: true, username: me.username, id: me.id });
    let autoEnabled = false;
    if (!out.enabled) { out = saveSettings(db, { enabled: true }, uid); autoEnabled = true; }
    wakeDoctorBot();
    return { ...out, auto_enabled: autoEnabled };
  } catch (e) {
    if (e instanceof TelegramError) return { ...recordCheck(db, { ok: false, error: e.message }), check_error: e.message };
    throw e;
  }
}

export function doctorBotTokenClear(db, _args, user) {
  requireAdmin(user);
  const s = clearToken(db, user && user.id ? user.id : null);
  wakeDoctorBot();
  return s;
}

export async function doctorBotTestConnection(db, _args, user, deps = {}) {
  requireAdmin(user);
  let token;
  try { token = getDecryptedToken(db); }
  catch (e) { return { ok: false, error: 'Сохранённый токен не читается: ' + e.message, settings: publicSettings(db) }; }
  if (!token) throw new RpcError('Токен бота не задан.', 400);
  try {
    const me = await getMe(token, deps);
    return { ok: true, bot: me, settings: recordCheck(db, { ok: true, username: me.username, id: me.id }) };
  } catch (e) {
    if (e instanceof TelegramError) return { ok: false, error: e.message, settings: recordCheck(db, { ok: false, error: e.message }) };
    throw e;
  }
}

/** Плитки вкладки: охват внешних врачей и уведомления за 30 дней. */
export function doctorBotStats(db, _args, user) {
  requireAdmin(user);
  const active = db.prepare("SELECT COUNT(*) n FROM referral_sources WHERE doctor_id IS NULL AND active = 1").get().n;
  const withPhone = db.prepare("SELECT COUNT(*) n FROM referral_sources WHERE doctor_id IS NULL AND active = 1 AND COALESCE(phone, '') <> ''").get().n;
  const connected = db.prepare(`SELECT COUNT(DISTINCT l.referral_source_id) n
                                  FROM doctor_bot_links l JOIN referral_sources rs ON rs.id = l.referral_source_id
                                 WHERE l.revoked_at IS NULL AND rs.doctor_id IS NULL AND rs.active = 1`).get().n;
  const n30 = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN viewed_at IS NOT NULL THEN 1 ELSE 0 END) AS viewed
                            FROM doctor_bot_notifications WHERE julianday(sent_at) >= julianday('now') - 30`).get();
  return {
    doctors_active: active, with_phone: withPhone, connected, without_phone: active - withPhone,
    notifications_30d: Number(n30.total) || 0, viewed_30d: Number(n30.viewed) || 0,
  };
}

export function doctorBotLinksList(db, _args, user) {
  requireAdmin(user);
  return db.prepare(`
    SELECT l.id, l.chat_id, l.tg_username, l.tg_name, l.linked_at, l.last_seen_at,
           rs.id AS source_id, rs.name AS source_name, rs.code AS source_code, rs.phone AS source_phone,
           (SELECT MAX(n.sent_at) FROM doctor_bot_notifications n WHERE n.link_id = l.id) AS last_notified_at,
           (SELECT COUNT(*) FROM doctor_bot_notifications n WHERE n.link_id = l.id) AS notifications
      FROM doctor_bot_links l JOIN referral_sources rs ON rs.id = l.referral_source_id
     WHERE l.revoked_at IS NULL
     ORDER BY rs.name`).all();
}

export function doctorBotLinkRevoke(db, args, user) {
  requireAdmin(user);
  const id = Number(args && args.id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Подключение не выбрано.', 400);
  const r = db.prepare(`UPDATE doctor_bot_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), revoked_by = ?
                         WHERE id = ? AND revoked_at IS NULL`).run(user && user.id ? user.id : null, id);
  return { id, revoked: r.changes > 0 };
}
