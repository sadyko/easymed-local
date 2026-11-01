// SMS_INFORM_V1 — RPC раздела «SMS-информирование» (Настройки →
// «Коммерческие инструменты»), провайдер Play Mobile.
//
// Why RPC and not /api/db: sms_settings намеренно НЕ заведена в
// schema-registry.js — до шифртекста пароля через запросный эндпоинт не
// добраться по построению (правило meta_settings и telephony_settings). Ничто
// из возвращаемого здесь пароля не содержит — только password_set и хвост.
//
// Раздел администраторский целиком, как «Телефония»: логин и пароль Play
// Mobile — это право слать SMS от имени клиники за её деньги. Своего ключа в
// «Ролях» у раздела пока нет; он появится, если владелец захочет выдавать
// раздел кому-то ещё.

import crypto from 'node:crypto';
import { isAdminUser } from '../grants.js';
import { publicSettings, saveSettings, clearPassword, connectionSettings, SettingsError } from '../sms/settings.js';
import { sendSms, normalizeUzPhone } from '../sms/playmobile.js';
import { SecretBoxError } from '../api/secret-box.js';
import { previewSmsAudience, resolveSmsAudience, startSmsBroadcast, smsBroadcastStatus } from '../sms/broadcast.js';   // SMS_PUSH_V1

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

function requireAdmin(user) {
  if (!isAdminUser(user)) throw new RpcError('Настройки SMS доступны только администратору.', 403);
}

function rethrow(e) {
  if (e instanceof SettingsError) throw new RpcError(e.message, e.status);
  if (e instanceof SecretBoxError) throw new RpcError(e.message, e.status || 409);
  throw e;
}

export function smsSettingsGet(db, _args, user) {
  requireAdmin(user);
  return publicSettings(db);
}

export function smsSettingsSave(db, args, user, deps = {}) {
  requireAdmin(user);
  try { return saveSettings(db, args || {}, user && user.id ? user.id : null, deps); }
  catch (e) { rethrow(e); }
}

export function smsPasswordClear(db, _args, user) {
  requireAdmin(user);
  return clearPassword(db, user && user.id ? user.id : null);
}

// Фразы причин — целыми строками (словарь экрана переводит только целые строки).
const REASON_TEXT = {
  network: 'Сервер клиники не достучался до Play Mobile: нет интернета или неверный адрес.',
  timeout: 'Play Mobile не ответил за 15 секунд.',
  auth: 'Play Mobile не принял логин или пароль.',
  http: 'Play Mobile отказал в отправке.',
};

/**
 * sms_send_test({ phone, text }) — одно сообщение сейчас, с записью в журнал.
 * Работает и при выключенной отправке: так проверяют подключение до включения.
 * Отказ провайдера — ok:false с причиной, НЕ исключение.
 */
export async function smsSendTest(db, args, user, deps = {}) {
  requireAdmin(user);
  const a = args || {};
  const phone = normalizeUzPhone(a.phone);
  if (!phone) throw new RpcError('Введите номер Узбекистана: +998 и девять цифр.', 400);
  const text = String(a.text || '').trim();
  if (!text) throw new RpcError('Введите текст сообщения.', 400);
  if (text.length > 1000) throw new RpcError('Текст сообщения — не длиннее 1000 символов.', 400);
  let conn;
  try { conn = connectionSettings(db, deps); } catch (e) { rethrow(e); }
  if (!conn.ready) throw new RpcError('Сначала заполните адрес, логин, пароль и имя отправителя.', 409);

  const messageId = 'em' + crypto.randomBytes(8).toString('hex');
  const r = await sendSms(conn, { phone, text, messageId }, deps);
  const reason = r.ok ? '' : (r.http_status === 401 || r.http_status === 403 ? 'auth' : r.reason);
  db.prepare(`INSERT INTO sms_messages (message_id, phone, text, kind, status, error, http_status, created_by)
              VALUES (?, ?, ?, 'test', ?, ?, ?, ?)`)
    .run(messageId, phone, text, r.ok ? 'sent' : 'failed', r.ok ? '' : (r.error || reason), r.http_status, user && user.id ? user.id : null);
  if (r.ok) return { ok: true, message_id: messageId };
  return { ok: false, reason, message: REASON_TEXT[reason] || REASON_TEXT.http, detail: r.error || '', http_status: r.http_status };
}

// ---------------------------------------------------------------------------
// SMS_PUSH_V1 — рассылка (Коммерческие инструменты → Push-уведомление → SMS)
// ---------------------------------------------------------------------------

/** sms_broadcast_preview({ filters, fresh }) — число получателей и несколько имён. */
export function smsBroadcastPreview(db, args, user) {
  requireAdmin(user);
  const a = args || {};
  return previewSmsAudience(db, a.filters || {}, { cache: a.fresh !== true });
}

/**
 * sms_broadcast_send({ text, filters, confirm_count }) — подтверждение числом
 * проверяется ЗДЕСЬ, как у Telegram: диалог в браузере — удобство, защита от
 * «разослал черновик всей базе» стоит на сервере.
 */
export function smsBroadcastSend(db, args, user, deps = {}) {
  requireAdmin(user);
  const a = args || {};
  const text = String(a.text || '').trim();
  if (!text) throw new RpcError('Введите текст сообщения.', 400);
  if (text.length > 1000) throw new RpcError('Текст сообщения — не длиннее 1000 символов.', 400);
  let conn;
  try { conn = connectionSettings(db, deps); } catch (e) { rethrow(e); }
  if (!conn.ready) throw new RpcError('Сначала заполните адрес, логин, пароль и имя отправителя.', 409);
  if (!conn.enabled) throw new RpcError('Отправка SMS выключена — включите её в «Настройки → Коммерческие инструменты → SMS-информирование».', 409);
  const filters = a.filters || {};
  const audience = resolveSmsAudience(db, filters);
  if (!audience.length) throw new RpcError('Под эти условия не подходит ни один пациент с номером Узбекистана.', 400);
  if (Number(a.confirm_count) !== audience.length) {
    throw new RpcError(`Число получателей изменилось: сейчас ${audience.length}. Проверьте и подтвердите заново.`, 409);
  }
  return startSmsBroadcast(db, conn, { text, filters, userId: user && user.id ? user.id : null, audience }, deps);
}

export function smsBroadcastStatusRpc(db, args, user) {
  requireAdmin(user);
  const st = smsBroadcastStatus(db, args && args.id);
  if (!st) throw new RpcError('Рассылка не найдена.', 404);
  return st;
}

/** sms_log_recent({ limit }) — журнал отправленного, новые вперёд. */
export function smsLogRecent(db, args, user) {
  requireAdmin(user);
  const lim = Math.min(200, Math.max(1, Number((args || {}).limit) || 50));
  return db.prepare(`
    SELECT m.id, m.message_id, m.phone, m.text, m.kind, m.status, m.error, m.http_status, m.created_at,
           COALESCE(u.full_name, '') AS created_by_name
      FROM sms_messages m
      LEFT JOIN users u ON u.id = m.created_by
     ORDER BY m.id DESC
     LIMIT ?`).all(lim);
}
