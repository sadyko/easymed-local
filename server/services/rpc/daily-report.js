// DAILY_REPORT_BOT_V1 (2026-11-13) — RPC инструмента «Отчёт в Telegram»
// («Коммерческие инструменты» → «Инструменты»): настройки бота, поиск группы,
// предпросмотр и «Отправить сейчас». Всё — только администратору клиники: отчёт
// несёт деньги клиники, а токен — право писать от её имени.
import { isAdminUser } from '../grants.js';
import { getMe, callApi, TelegramError } from '../telegram/api.js';
import { publicSettings, saveSettings, clearToken, getDecryptedToken, recordBot, SettingsError,
         clashMessage, readSettingsRow, sectionsOf } from '../daily-report/settings.js';
import { buildReport, reportDay } from '../daily-report/report.js';
import { sendReport, armForNextRun } from '../daily-report/index.js';

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function requireAdmin(user) {
  if (isAdminUser(user)) return;
  throw new RpcError('Отчёт в Telegram настраивает администратор клиники.', 403);
}
const uidOf = (user) => (user && user.id ? user.id : null);
function tokenOrThrow(db) {
  let token;
  try { token = getDecryptedToken(db); } catch (e) { throw new RpcError('Сохранённый токен не читается: ' + e.message, 400); }
  if (!token) throw new RpcError('Сначала сохраните токен бота.', 400);
  return token;
}

export function dailyReportSettingsGet(db, _args, user) {
  requireAdmin(user);
  return publicSettings(db);
}

/**
 * Сохранить. Новый токен сразу проверяется (getMe): имя бота на экран, чужой
 * бот клиники — отказ. Включение или новое время после сегодняшнего часа
 * отправки — первый отчёт в следующий раз (armForNextRun).
 */
export async function dailyReportSettingsSave(db, args, user, deps = {}) {
  requireAdmin(user);
  const a = args || {};
  let settings;
  try { settings = saveSettings(db, a, uidOf(user)); }
  catch (e) { if (e instanceof SettingsError) throw new RpcError(e.message, e.status); throw e; }
  if (a.enabled !== undefined || a.send_time !== undefined) armForNextRun(db);

  const tokenAdded = a.bot_token && String(a.bot_token).trim() !== '';
  if (!tokenAdded) return publicSettings(db);
  const token = tokenOrThrow(db);
  try {
    const me = await getMe(token, deps);
    const clash = clashMessage(db, me && me.id);
    if (clash) { clearToken(db, uidOf(user)); throw new RpcError(clash, 400); }
    return recordBot(db, { username: me.username, id: me.id });
  } catch (e) {
    if (e instanceof TelegramError) return { ...settings, check_error: e.message };
    throw e;
  }
}

export function dailyReportTokenClear(db, _args, user) {
  requireAdmin(user);
  return clearToken(db, uidOf(user));
}

/**
 * Группы, где бот есть: из последних обновлений бота — его добавили в группу
 * (my_chat_member) или в группе ему написали. Telegram хранит обновления сутки;
 * пусто — добавьте бота в группу (или напишите в ней что-нибудь) и нажмите снова.
 */
export async function dailyReportFindChats(db, _args, user, deps = {}) {
  requireAdmin(user);
  const token = tokenOrThrow(db);
  let updates;
  try {
    updates = await callApi(token, 'getUpdates', { offset: 0, timeout: 0, allowed_updates: ['message', 'my_chat_member'] }, deps);
  } catch (e) {
    if (e instanceof TelegramError) throw new RpcError(e.message, 400);
    throw e;
  }
  const seen = new Map();
  const gone = new Set();
  for (const u of Array.isArray(updates) ? updates : []) {
    const mcm = u && u.my_chat_member;
    const chat = (mcm && mcm.chat) || (u && u.message && u.message.chat);
    if (!chat || !['group', 'supergroup'].includes(chat.type)) continue;
    const id = String(chat.id);
    // Последнее слово — за последним обновлением: бота добавили, потом убрали.
    if (mcm && mcm.new_chat_member && ['left', 'kicked'].includes(mcm.new_chat_member.status)) { gone.add(id); seen.delete(id); continue; }
    gone.delete(id);
    seen.set(id, { id, title: chat.title || id, type: chat.type });
  }
  return { chats: [...seen.values()] };
}

/** Текст отчёта, как он уйдёт, — без отправки. */
export function dailyReportPreview(db, _args, user) {
  requireAdmin(user);
  const row = readSettingsRow(db) || {};
  return buildReport(db, { day: reportDay(db, row.period), sections: sectionsOf(row.sections) });
}

/** «Отправить сейчас» — проверка на группе; расписание («сегодня отправлено») не трогает. */
export async function dailyReportSendNow(db, _args, user, deps = {}) {
  requireAdmin(user);
  const res = await sendReport(db, { scheduled: false, deps });
  return { ...res, settings: publicSettings(db) };
}
