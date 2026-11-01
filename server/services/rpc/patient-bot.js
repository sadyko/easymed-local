// PATIENT_BOT_INVITE_V1 (2026-11-01) — Telegram-бот пациента в списке пациентов.
//
// Владелец: «at the end of patientline add button to send bot link to patient
// if patient has no bot, if patinet has bot, small telegram logo should be
// there». Два вызова:
//
//   patient_bot_status({ ids }) — кто из пациентов страницы уже подключён к
//     боту: живая связка telegram_links (revoked_at пуст) на тот же номер
//     (ключ phoneKey — те же 9 цифр, что сравнивают CRM и боты). Наружу —
//     только id пациентов, ни номеров, ни чатов. Прежняя отметка у имени
//     читала telegram_chats_list и была видна лишь роли с правом чата (и лишь
//     по последним 300 чатам); эта — всем, кто видит список пациентов.
//
//   patient_bot_invite({ patient_id }) — ссылка на бота SMS на номер пациента
//     (Play Mobile, services/sms). SMS не настроено или выключено — отказа нет:
//     ответ { ok: false, sms: false, link }, и экран кладёт ссылку в буфер
//     обмена, чтобы регистратор отправил её сам. Одному пациенту — не чаще
//     раза в 10 минут (журнал patient_bot_invites, мигр. 268).
import crypto from 'node:crypto';
import { isAdminUser } from '../grants.js';
import { canViewSection } from '../roles.js';
import { phoneKey } from '../../../public/js/admin/views/crm-phone-match.js';
import { connectionSettings } from '../sms/settings.js';
import { sendSms, normalizeUzPhone } from '../sms/playmobile.js';

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const MAX_IDS = 200;
const REPEAT_MINUTES = 10;

function requirePatients(db, user) {
  if (!user || !user.id) throw new RpcError('Нужно войти в систему.', 401);
  if (isAdminUser(user) || canViewSection(db, user, 'patients')) return;
  throw new RpcError('Список пациентов недоступен вашей роли.', 403);
}

/** Имя пациентского бота ('' — бот не подключён). */
export function patientBotUsername(db) {
  try {
    const r = db.prepare('SELECT bot_username, enabled FROM telegram_settings WHERE id = 1').get();
    return r && r.enabled && r.bot_username ? String(r.bot_username) : '';
  } catch { return ''; }   // сборка без бота
}

function smsReady(db, deps) {
  try { const c = connectionSettings(db, deps); return !!(c.enabled && c.ready); } catch { return false; }
}

function linkedKeys(db) {
  let rows = [];
  try { rows = db.prepare('SELECT phone FROM telegram_links WHERE revoked_at IS NULL').all(); } catch { rows = []; }
  return new Set(rows.map((r) => phoneKey(r.phone)).filter(Boolean));
}

export function patientBotStatus(db, args, user, deps = {}) {
  requirePatients(db, user);
  const ids = (Array.isArray(args && args.ids) ? args.ids : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_IDS);
  const bot = patientBotUsername(db);
  const out = { bot: !!bot, sms_ready: smsReady(db, deps), linked: [] };
  if (!bot || !ids.length) return out;
  const keys = linkedKeys(db);
  if (!keys.size) return out;
  const rows = db.prepare('SELECT id, phone FROM patients WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids));
  out.linked = rows.filter((p) => { const k = phoneKey(p.phone); return k && keys.has(k); }).map((p) => p.id);
  return out;
}

/** Текст SMS: по-русски и по-узбекски, ссылка одна. */
export function inviteText(link) {
  return `Telegram-бот клиники: запись, результаты и напоминания. Klinika Telegram boti: ${link}`;
}

export async function patientBotInvite(db, args, user, deps = {}) {
  requirePatients(db, user);
  const id = Number(args && args.patient_id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Пациент не выбран.', 400);
  const p = db.prepare('SELECT id, phone FROM patients WHERE id = ?').get(id);
  if (!p) throw new RpcError('Пациент не найден.', 404);
  const bot = patientBotUsername(db);
  if (!bot) throw new RpcError('Telegram-бот клиники не подключён — его включают в «Настройки → Telegram-бот».', 409);
  const link = 'https://t.me/' + bot;
  const phone = normalizeUzPhone(p.phone);
  if (!phone) throw new RpcError('У пациента нет номера телефона Узбекистана — отправить ссылку некуда.', 400);
  if (linkedKeys(db).has(phoneKey(p.phone))) throw new RpcError('Пациент уже подключён к боту.', 409);

  const recent = db.prepare(`SELECT 1 FROM patient_bot_invites
                              WHERE patient_id = ? AND status = 'sent'
                                AND julianday(created_at) > julianday('now') - ? / 1440.0`).get(id, REPEAT_MINUTES);
  // Тот же номер мог получить ссылку из карточки заявки (lead_bot_invites).
  if (recent || sentRecentlyTo(db, phone)) throw new RpcError('Ссылка этому пациенту уже отправлена в последние 10 минут.', 429);

  let conn = null;
  try { conn = connectionSettings(db, deps); } catch { conn = null; }
  if (!conn || !conn.enabled || !conn.ready) return { ok: false, sms: false, link };

  const messageId = 'eb' + crypto.randomBytes(8).toString('hex');
  const r = await sendSms(conn, { phone, text: inviteText(link), messageId }, deps);
  db.prepare(`INSERT INTO patient_bot_invites (patient_id, phone, status, error, message_id, created_by)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, phone, r.ok ? 'sent' : 'failed', r.ok ? '' : String(r.error || r.reason || '').slice(0, 300), messageId, user.id);
  if (r.ok) return { ok: true, sms: true, link };
  return { ok: false, sms: true, link, message: 'SMS не ушло — Play Mobile отказал. Ссылка скопирована, отправьте её пациенту сами.' };
}

// ---------------------------------------------------------------------------
// КАРТОЧКА ЗАЯВКИ CRM — по НОМЕРУ (владелец: «put to the lead card too,
// telegram bot button link»). У заявки пациента в базе может не быть, поэтому
// и статус, и ссылка — по телефону с карточки. Право — CRM или список
// пациентов: карточку заявки открывает оператор колл-центра. Журнал —
// lead_bot_invites (мигр. 269); повтор в 10 минут проверяется по номеру в
// обоих журналах.
// ---------------------------------------------------------------------------
function requireCrmOrPatients(db, user) {
  if (!user || !user.id) throw new RpcError('Нужно войти в систему.', 401);
  if (isAdminUser(user) || canViewSection(db, user, 'crm') || canViewSection(db, user, 'patients')) return;
  throw new RpcError('Карточка заявки недоступна вашей роли.', 403);
}

/** phone_bot_status({ phone }) → { bot, sms_ready, valid, linked }. Номер наружу не возвращается. */
export function phoneBotStatus(db, args, user, deps = {}) {
  requireCrmOrPatients(db, user);
  const raw = String((args && args.phone) || '');
  const valid = !!normalizeUzPhone(raw);
  const bot = patientBotUsername(db);
  return {
    bot: !!bot, sms_ready: smsReady(db, deps), valid,
    linked: !!(bot && valid && linkedKeys(db).has(phoneKey(raw))),
  };
}

function sentRecentlyTo(db, phone) {
  const q = (table) => db.prepare(`SELECT 1 FROM ${table} WHERE phone = ? AND status = 'sent'
                                     AND julianday(created_at) > julianday('now') - ? / 1440.0`).get(phone, REPEAT_MINUTES);
  return !!(q('lead_bot_invites') || q('patient_bot_invites'));
}

/** phone_bot_invite({ phone, lead_id }) — ссылка на бота SMS на номер с карточки заявки. */
export async function phoneBotInvite(db, args, user, deps = {}) {
  requireCrmOrPatients(db, user);
  const raw = String((args && args.phone) || '');
  const bot = patientBotUsername(db);
  if (!bot) throw new RpcError('Telegram-бот клиники не подключён — его включают в «Настройки → Telegram-бот».', 409);
  const link = 'https://t.me/' + bot;
  const phone = normalizeUzPhone(raw);
  if (!phone) throw new RpcError('Введите номер Узбекистана: +998 и девять цифр.', 400);
  if (linkedKeys(db).has(phoneKey(raw))) throw new RpcError('Этот номер уже подключён к боту.', 409);
  if (sentRecentlyTo(db, phone)) throw new RpcError('Ссылка на этот номер уже отправлена в последние 10 минут.', 429);
  const leadId = Number(args && args.lead_id);

  let conn = null;
  try { conn = connectionSettings(db, deps); } catch { conn = null; }
  if (!conn || !conn.enabled || !conn.ready) return { ok: false, sms: false, link };

  const messageId = 'el' + crypto.randomBytes(8).toString('hex');
  const r = await sendSms(conn, { phone, text: inviteText(link), messageId }, deps);
  db.prepare(`INSERT INTO lead_bot_invites (lead_id, phone, status, error, message_id, created_by)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(Number.isInteger(leadId) && leadId > 0 ? leadId : null, phone, r.ok ? 'sent' : 'failed',
      r.ok ? '' : String(r.error || r.reason || '').slice(0, 300), messageId, user.id);
  if (r.ok) return { ok: true, sms: true, link };
  return { ok: false, sms: true, link, message: 'SMS не ушло — Play Mobile отказал. Ссылка скопирована, отправьте её пациенту сами.' };
}
