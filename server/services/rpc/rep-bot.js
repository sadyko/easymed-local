// REP_BOT_V1 (2026-10-30) — RPC вкладки «Реферирование → Бот представителей»:
// настройки бота, проверка связи, плитки, подключения (с подтверждением) и
// список врачей, заведённых через бота. Всё — только администратору клиники:
// токен открывает переписку, а подтверждение даёт чату право заводить врачей.
import { isAdminUser } from '../grants.js';
import { getMe, TelegramError } from '../telegram/api.js';
import { publicSettings, saveSettings, clearToken, getDecryptedToken, recordCheck, SettingsError,
         clashMessage } from '../rep-bot/settings.js';
import { wakeRepBot } from '../rep-bot/index.js';
import { repOfLink } from '../rep-bot/flow.js';
import { representativeCodes } from './referrals.js';

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function requireAdmin(user) {
  if (isAdminUser(user)) return;
  throw new RpcError('Бот для медпредставителей настраивает администратор клиники.', 403);
}
function rethrow(e) {
  if (e instanceof SettingsError) throw new RpcError(e.message, e.status);
  throw e;
}
const uidOf = (user) => (user && user.id ? user.id : null);

export function repBotSettingsGet(db, _args, user) {
  requireAdmin(user);
  return publicSettings(db);
}

/** Как у бота врачей: новый токен сразу проверяется, удачный — включает бота сам. */
export async function repBotSettingsSave(db, args, user, deps = {}) {
  requireAdmin(user);
  const uid = uidOf(user);
  let settings;
  try { settings = saveSettings(db, args || {}, uid); } catch (e) { return rethrow(e); }

  const tokenAdded = args && args.bot_token && String(args.bot_token).trim() !== '';
  if (!tokenAdded) { wakeRepBot(); return settings; }

  let token;
  try { token = getDecryptedToken(db); } catch (e) { return { ...settings, check_error: 'Сохранённый токен не читается: ' + e.message }; }
  try {
    const me = await getMe(token, deps);
    const clash = clashMessage(db, me && me.id);
    if (clash) {
      clearToken(db, uid);
      wakeRepBot();
      throw new RpcError(clash, 400);
    }
    let out = recordCheck(db, { ok: true, username: me.username, id: me.id });
    let autoEnabled = false;
    if (!out.enabled) { out = saveSettings(db, { enabled: true }, uid); autoEnabled = true; }
    wakeRepBot();
    return { ...out, auto_enabled: autoEnabled };
  } catch (e) {
    if (e instanceof TelegramError) return { ...recordCheck(db, { ok: false, error: e.message }), check_error: e.message };
    throw e;
  }
}

export function repBotTokenClear(db, _args, user) {
  requireAdmin(user);
  const s = clearToken(db, uidOf(user));
  wakeRepBot();
  return s;
}

export async function repBotTestConnection(db, _args, user, deps = {}) {
  requireAdmin(user);
  let token;
  try { token = getDecryptedToken(db); }
  catch (e) { return { ok: false, error: 'Сохранённый токен не читается: ' + e.message, settings: publicSettings(db) }; }
  if (!token) throw new RpcError('Токен бота не задан.', 400);
  try {
    const me = await getMe(token, deps);
    const clash = clashMessage(db, me && me.id);
    if (clash) {
      recordCheck(db, { ok: false, error: clash });
      const off = saveSettings(db, { enabled: false }, uidOf(user));
      wakeRepBot();
      return { ok: false, error: clash, settings: off };
    }
    return { ok: true, bot: me, settings: recordCheck(db, { ok: true, username: me.username, id: me.id }) };
  } catch (e) {
    if (e instanceof TelegramError) return { ok: false, error: e.message, settings: recordCheck(db, { ok: false, error: e.message }) };
    throw e;
  }
}

/** Плитки: представителей, с телефоном, подключены, ждут, врачей через бота за 30 дней. */
export function repBotStats(db, _args, user) {
  requireAdmin(user);
  const codes = representativeCodes(db);
  const holes = codes.map(() => '?').join(',');
  const reps = db.prepare(`SELECT COUNT(*) n FROM users WHERE is_active = 1 AND custom_role_code IN (${holes})`).get(...codes).n;
  const withPhone = db.prepare(`SELECT COUNT(*) n FROM users WHERE is_active = 1 AND custom_role_code IN (${holes}) AND COALESCE(phone, '') <> ''`).get(...codes).n;
  const byStatus = (status) => db.prepare(`SELECT COUNT(DISTINCT user_id) n FROM rep_bot_links WHERE revoked_at IS NULL AND status = ?`).get(status).n;
  const added30 = db.prepare(`SELECT COUNT(*) n FROM rep_bot_additions WHERE julianday(created_at) >= julianday('now') - 30`).get().n;
  return {
    reps_active: reps, with_phone: withPhone, without_phone: reps - withPhone,
    connected: byStatus('confirmed'), pending: byStatus('pending'), added_30d: added30,
  };
}

export function repBotLinksList(db, _args, user) {
  requireAdmin(user);
  return db.prepare(`
    SELECT l.id, l.user_id, l.tg_username, l.tg_name, l.linked_at, l.last_seen_at, l.status, l.confirmed_at,
           substr(l.phone, -4) AS phone_tail,
           u.full_name AS rep_name, u.phone AS rep_phone,
           (SELECT COUNT(*) FROM rep_bot_additions a WHERE a.link_id = l.id) AS added
      FROM rep_bot_links l JOIN users u ON u.id = l.user_id
     WHERE l.revoked_at IS NULL
     ORDER BY u.full_name`).all();
}

/** Последние 50 врачей, заведённых через бота: кто завёл и когда. */
export function repBotAdditionsList(db, _args, user) {
  requireAdmin(user);
  return db.prepare(`
    SELECT a.id, a.created_at, rs.id AS source_id, rs.code AS source_code, rs.name AS source_name,
           rs.phone AS source_phone, rs.specialty, rs.workplace, rs.active,
           u.full_name AS rep_name
      FROM rep_bot_additions a
      JOIN referral_sources rs ON rs.id = a.referral_source_id
      LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT 50`).all();
}

function linkIdOf(args) {
  const id = Number(args && args.id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Подключение не выбрано.', 400);
  return id;
}

/** «Подтвердить»: только ждущее, только пока сотрудник — всё ещё представитель с этим номером. */
export function repBotLinkConfirm(db, args, user) {
  requireAdmin(user);
  const id = linkIdOf(args);
  const l = db.prepare('SELECT * FROM rep_bot_links WHERE id = ?').get(id);
  if (!l || l.revoked_at || l.status !== 'pending') throw new RpcError('Это подключение уже подтверждено, отклонено или отключено.', 409);
  if (!repOfLink(db, l)) {
    throw new RpcError('Сотрудник отключён, у него сменилась роль или номер — подтвердить нельзя. Попросите его отправить номер снова.', 409);
  }
  db.prepare(`UPDATE rep_bot_links SET status = 'confirmed', confirmed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), confirmed_by = ?
               WHERE id = ? AND status = 'pending' AND revoked_at IS NULL`).run(uidOf(user), id);
  return { id, confirmed: true };
}

export function repBotLinkReject(db, args, user) {
  requireAdmin(user);
  const id = linkIdOf(args);
  const r = db.prepare(`UPDATE rep_bot_links SET status = 'rejected', revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), revoked_by = ?
                         WHERE id = ? AND status = 'pending' AND revoked_at IS NULL`).run(uidOf(user), id);
  if (!r.changes) throw new RpcError('Это подключение уже подтверждено, отклонено или отключено.', 409);
  return { id, rejected: true };
}

export function repBotLinkRevoke(db, args, user) {
  requireAdmin(user);
  const id = linkIdOf(args);
  const r = db.prepare(`UPDATE rep_bot_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), revoked_by = ?
                         WHERE id = ? AND revoked_at IS NULL`).run(uidOf(user), id);
  db.prepare('DELETE FROM rep_bot_drafts WHERE link_id = ?').run(id);
  return { id, revoked: r.changes > 0 };
}
