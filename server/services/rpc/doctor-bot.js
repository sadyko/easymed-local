// REFERRALS_CRM_V1 (2026-10-26) — RPC вкладки «Реферирование → Telegram-бот»:
// настройки бота для врачей-источников, проверка связи, охват, подключённые.
// Всё — только администратору клиники (как токен пациентского бота): токен
// открывает переписку с врачами, а список подключённых — их телефоны.
import { isAdminUser } from '../grants.js';
import { getMe, TelegramError } from '../telegram/api.js';
import { publicSettings, saveSettings, clearToken, getDecryptedToken, recordCheck, SettingsError,
         isPatientBot, SAME_BOT_MESSAGE } from '../doctor-bot/settings.js';   // FIX_318_V1 (M1)
import { wakeDoctorBot } from '../doctor-bot/index.js';
import { linkMatchesSource } from '../doctor-bot/notify.js';   // FIX_318_V1 (M2) — номер связки — номер врача

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
    // FIX_318_V1 (M1) — Telegram ответил тем же ботом, что пациентский:
    // токен не оставляем (иначе второй поллер того же бота), бот выключен.
    if (isPatientBot(db, me && me.id)) {
      clearToken(db, uid);
      wakeDoctorBot();
      throw new RpcError(SAME_BOT_MESSAGE, 400);
    }
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
    // FIX_318_V1 (M1) — пациентский бот стал этим же ботом: проверка не
    // проходит, бот для врачей выключается до замены токена.
    if (isPatientBot(db, me && me.id)) {
      recordCheck(db, { ok: false, error: SAME_BOT_MESSAGE });
      const off = saveSettings(db, { enabled: false }, user && user.id ? user.id : null);
      wakeDoctorBot();
      return { ok: false, error: SAME_BOT_MESSAGE, settings: off };
    }
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
  // FIX_318_V1 (M2) — «подключили» — подтверждённые администратором; ждущие — отдельно.
  const byStatus = (status) => db.prepare(`SELECT COUNT(DISTINCT l.referral_source_id) n
                                  FROM doctor_bot_links l JOIN referral_sources rs ON rs.id = l.referral_source_id
                                 WHERE l.revoked_at IS NULL AND l.status = ? AND rs.doctor_id IS NULL AND rs.active = 1`).get(status).n;
  const connected = byStatus('confirmed');
  const pending = byStatus('pending');
  const n30 = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN viewed_at IS NOT NULL THEN 1 ELSE 0 END) AS viewed
                            FROM doctor_bot_notifications WHERE julianday(sent_at) >= julianday('now') - 30`).get();
  return {
    doctors_active: active, with_phone: withPhone, connected, pending, without_phone: active - withPhone,
    notifications_30d: Number(n30.total) || 0, viewed_30d: Number(n30.viewed) || 0,
  };
}

// FIX_318_V1 (M2) — и ждущие подтверждения: status ('pending' | 'confirmed') и
// последние 4 цифры номера, присланного из Telegram (phone_tail), — по ним
// администратор сверяет, тот ли это врач.
export function doctorBotLinksList(db, _args, user) {
  requireAdmin(user);
  return db.prepare(`
    SELECT l.id, l.chat_id, l.tg_username, l.tg_name, l.linked_at, l.last_seen_at, l.status, l.confirmed_at,
           substr(l.phone, -4) AS phone_tail,
           rs.id AS source_id, rs.name AS source_name, rs.code AS source_code, rs.phone AS source_phone,
           (SELECT MAX(n.sent_at) FROM doctor_bot_notifications n WHERE n.link_id = l.id) AS last_notified_at,
           (SELECT COUNT(*) FROM doctor_bot_notifications n WHERE n.link_id = l.id) AS notifications
      FROM doctor_bot_links l JOIN referral_sources rs ON rs.id = l.referral_source_id
     WHERE l.revoked_at IS NULL
     ORDER BY rs.name`).all();
}

function linkIdOf(args) {
  const id = Number(args && args.id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Подключение не выбрано.', 400);
  return id;
}

/**
 * FIX_318_V1 (M2) — «Подтвердить»: врач прислал номер, администратор узнал его
 * — бот начинает писать. Только ждущее подключение, только пока врач включён
 * и номер связки — его номер в справочнике (иначе 409: попросить отправить
 * номер снова).
 */
export function doctorBotLinkConfirm(db, args, user) {
  requireAdmin(user);
  const id = linkIdOf(args);
  const l = db.prepare(`SELECT l.id, l.status, l.revoked_at, l.phone, rs.phone AS source_phone, rs.active
                          FROM doctor_bot_links l JOIN referral_sources rs ON rs.id = l.referral_source_id
                         WHERE l.id = ?`).get(id);
  if (!l || l.revoked_at || l.status !== 'pending') throw new RpcError('Это подключение уже подтверждено, отклонено или отключено.', 409);
  if (!l.active || !linkMatchesSource(l.phone, l.source_phone)) {
    throw new RpcError('Врач выключен или его номер в справочнике изменился — подтвердить нельзя. Попросите врача отправить номер снова.', 409);
  }
  db.prepare(`UPDATE doctor_bot_links SET status = 'confirmed', confirmed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), confirmed_by = ?
               WHERE id = ? AND status = 'pending' AND revoked_at IS NULL`).run(user && user.id ? user.id : null, id);
  wakeDoctorBot();
  return { id, confirmed: true };
}

/** FIX_318_V1 (M2) — «Отклонить»: подключение отозвано и помечено отклонённым (строка — история). */
export function doctorBotLinkReject(db, args, user) {
  requireAdmin(user);
  const id = linkIdOf(args);
  const r = db.prepare(`UPDATE doctor_bot_links SET status = 'rejected', revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), revoked_by = ?
                         WHERE id = ? AND status = 'pending' AND revoked_at IS NULL`).run(user && user.id ? user.id : null, id);
  if (!r.changes) throw new RpcError('Это подключение уже подтверждено, отклонено или отключено.', 409);
  return { id, rejected: true };
}

export function doctorBotLinkRevoke(db, args, user) {
  requireAdmin(user);
  const id = Number(args && args.id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Подключение не выбрано.', 400);
  const r = db.prepare(`UPDATE doctor_bot_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), revoked_by = ?
                         WHERE id = ? AND revoked_at IS NULL`).run(user && user.id ? user.id : null, id);
  return { id, revoked: r.changes > 0 };
}
