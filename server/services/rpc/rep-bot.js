// REP_BOT_V1 (2026-10-30) — RPC вкладки «Реферирование → Бот представителей»:
// настройки бота, проверка связи, плитки, подключения (с подтверждением) и
// список врачей, заведённых через бота. Всё — только администратору клиники:
// токен открывает переписку, а подтверждение даёт чату право заводить врачей.
import { isAdminUser } from '../grants.js';
import { getMe, sendMessage, TelegramError } from '../telegram/api.js';
import { publicSettings, saveSettings, clearToken, getDecryptedToken, recordCheck, SettingsError,
         clashMessage } from '../rep-bot/settings.js';
import { wakeRepBot, botConfig } from '../rep-bot/index.js';
import { repOfLink, T as BOT_TEXT } from '../rep-bot/flow.js';
import { representativeCodes, referralsAssignRepresentative } from './referrals.js';

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

// ---------------------------------------------------------------------------
// REP_BOT_CLAIMS_V1 (2026-11-20) — заявки на закрепление существующего врача.
//
// Владелец: «if there is doctor with the same number it should go to
// approvement before adding to medical representative». Бот заводит заявку,
// когда номер из анкеты уже есть у внешнего врача (rep-bot/flow.js fileClaim);
// здесь администратор её видит и решает. Подтверждение ПЕРЕНОСИТ врача к
// заявителю, даже если он был закреплён за другим представителем — тот
// получает сообщение в боте. Карточку врача заявка не меняет.
// ---------------------------------------------------------------------------

/** Открытые заявки: врач, заявитель, кто закреплён сейчас (или null), когда. */
export function repBotClaimsList(db, _args, user) {
  requireAdmin(user);
  return db.prepare(`
    SELECT c.id, c.created_at, c.entered_name,
           rs.id AS source_id, rs.code AS source_code, rs.name AS source_name, rs.phone AS source_phone,
           c.user_id AS requester_id, ru.full_name AS requester_name,
           rs.representative_id AS current_rep_id, cu.full_name AS current_rep_name
      FROM rep_bot_claims c
      JOIN referral_sources rs ON rs.id = c.referral_source_id
      LEFT JOIN users ru ON ru.id = c.user_id
      LEFT JOIN users cu ON cu.id = rs.representative_id
     WHERE c.status = 'pending'
     ORDER BY c.created_at, c.id`).all();
}

const CLAIM_DONE = 'Эта заявка уже рассмотрена.';
const CLAIM_VOID_SOURCE = 'Врач из заявки больше не внешний врач-источник — заявка закрыта без закрепления.';
const CLAIM_VOID_REP = 'Заявитель больше не действующий медпредставитель (отключён или снята роль) — заявка закрыта без закрепления.';

/** Чат подтверждённой живой связки сотрудника с ботом, или null. */
function repChat(db, userId) {
  if (userId == null) return null;
  const r = db.prepare(`SELECT chat_id FROM rep_bot_links
                         WHERE user_id = ? AND revoked_at IS NULL AND status = 'confirmed'
                         ORDER BY id DESC LIMIT 1`).get(userId);
  return r ? r.chat_id : null;
}

/** Отправка сообщением бота представителей; null — бот выключен или без токена. */
async function defaultSend(db, chatId, text) {
  const cfg = botConfig(db);
  if (!cfg) return null;
  return sendMessage(cfg.token, chatId, text);
}

/**
 * «Подтвердить» / «Отклонить». Подтверждение в ОДНОЙ транзакции: заявка всё ещё
 * открыта; врач существует и внешний; заявитель — действующий сотрудник с ролью
 * «Медпредставитель»; закрепление — той же серверной функцией, что вкладка
 * «Представители» (referralsAssignRepresentative), не копией её SQL. Проверка
 * не прошла — заявка 'void' (сохраняется) и понятный отказ администратору.
 * Сообщения в бот — после транзакции и best-effort: сбой Telegram решение не
 * отменяет.
 */
export async function repBotClaimDecide(db, args, user, deps = {}) {
  requireAdmin(user);
  const id = Number(args && args.id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Заявка не выбрана.', 400);
  const decision = args && args.decision;
  if (decision !== 'approve' && decision !== 'reject') throw new RpcError('Решение по заявке — «Подтвердить» или «Отклонить».', 400);
  const uid = uidOf(user);
  const close = (status, prev = null) => db.prepare(`UPDATE rep_bot_claims SET status = ?, prev_representative_id = ?,
      decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? AND status = 'pending'`).run(status, prev, uid, id);

  const out = db.transaction(() => {
    const c = db.prepare('SELECT * FROM rep_bot_claims WHERE id = ?').get(id);
    if (!c || c.status !== 'pending') throw new RpcError(CLAIM_DONE, 409);
    const src = db.prepare('SELECT id, code, name, doctor_id, representative_id FROM referral_sources WHERE id = ?').get(c.referral_source_id);
    if (decision === 'reject') {
      close('rejected');
      return { claim: c, src, status: 'rejected' };
    }
    if (!src || src.doctor_id != null) { close('void'); return { status: 'void', message: CLAIM_VOID_SOURCE }; }
    const codes = representativeCodes(db);
    const rep = c.user_id == null ? null
      : db.prepare(`SELECT id FROM users WHERE id = ? AND is_active = 1 AND custom_role_code IN (${codes.map(() => '?').join(',')})`)
        .get(c.user_id, ...codes);
    if (!rep) { close('void'); return { status: 'void', message: CLAIM_VOID_REP }; }
    const prev = src.representative_id;
    referralsAssignRepresentative(db, { source_id: src.id, user_id: c.user_id }, user);
    close('approved', prev);
    return { claim: c, src, status: 'approved', prev };
  })();

  if (out.status === 'void') throw new RpcError(out.message, 409);

  const send = deps.send || defaultSend;
  const notify = async (userId, text) => {
    const chat = repChat(db, userId);
    if (!chat) return;
    try { await send(db, chat, text); }
    catch (e) { console.warn('[rep-bot] claim notice not sent:', (e && e.message) || e); }
  };
  const { claim, src } = out;
  if (out.status === 'approved') {
    await notify(claim.user_id, BOT_TEXT.claimApproved(src.name, src.code || ''));
    if (out.prev != null && out.prev !== claim.user_id) await notify(out.prev, BOT_TEXT.claimMoved(src.name, src.code || ''));
    return { id, status: 'approved', source_id: src.id, representative_id: claim.user_id, prev_representative_id: out.prev };
  }
  if (src) await notify(claim.user_id, BOT_TEXT.claimRejected(src.name, src.code || ''));
  return { id, status: 'rejected' };
}
