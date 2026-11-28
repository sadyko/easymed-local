// STAFF_ATTENDANCE_V1 — настройки бота сотрудников (EasyMed Staff): одна
// строка staff_bot_settings (id = 1). Токен зашифрован тем же ключом
// data/.telegram-key, что у остальных ботов клиники (telegram/crypto.js);
// ТЗ просит «секреты не в коде» — так и есть: токен вводят на экране, в базе
// он только зашифрованным, в ответах API — подсказкой «1234…abcd».
//
// Бот сотрудников обязан быть ОТДЕЛЬНЫМ ботом: два поллера одного токена
// отнимают друг у друга сообщения (Telegram отвечает 409). Токен любого
// другого бота клиники отвергается здесь и не опрашивается поллером.
import { encryptToken, decryptToken, loadOrCreateKey, looksLikeBotToken, tokenHint } from '../telegram/crypto.js';
import { botIdOfToken, storedBotId } from '../doctor-bot/settings.js';

export class SettingsError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const OTHER_BOTS = [
  ['telegram_settings', 'пациентского бота'],
  ['doctor_bot_settings', 'бота для врачей-источников'],
  ['rep_bot_settings', 'бота для медпредставителей'],
  ['daily_report_settings', 'бота отчёта совету директоров'],
];

/** Отказ, если id — номер другого бота клиники; '' — бот свой. */
export function clashMessage(db, id, opts = {}) {
  const mine = String(id == null ? '' : id).trim();
  if (!mine) return '';
  for (const [table, what] of OTHER_BOTS) {
    if (mine === storedBotId(db, table, opts)) {
      return `Это токен ${what}. Для сотрудников нужен ДРУГОЙ бот: создайте его в @BotFather (команда /newbot) и вставьте его токен.`;
    }
  }
  return '';
}

export function readSettingsRow(db) {
  return db.prepare('SELECT * FROM staff_bot_settings WHERE id = 1').get();
}

export function publicSettings(db) {
  const row = readSettingsRow(db) || {};
  return {
    enabled: !!row.enabled,
    has_token: !!row.bot_token_enc,
    token_hint: row.bot_token_hint || '',
    bot_username: row.bot_username || '',
    bot_id: row.bot_id || '',
    last_check_status: row.last_check_status || '',
    last_check_error: row.last_check_error || '',
    last_check_at: row.last_check_at || null,
    grace_minutes: row.grace_minutes ?? 10,
    updated_at: row.updated_at || null,
  };
}

/**
 * Токен, выключатель и «опоздание после N минут». Новый токен сбрасывает имя
 * бота — его заново запишет проверка связи (без имени бота QR не собрать:
 * ссылка t.me/<имя>). Включить бота без токена нельзя.
 */
export function saveSettings(db, args = {}, userId = null, { keyPath } = {}) {
  const row = readSettingsRow(db);
  if (!row) throw new SettingsError('Настройки бота сотрудников не инициализированы.', 500);
  const patch = {
    enabled: args.enabled === undefined ? row.enabled : (args.enabled ? 1 : 0),
    bot_token_enc: row.bot_token_enc, bot_token_hint: row.bot_token_hint,
    bot_username: row.bot_username, bot_id: row.bot_id,
    last_check_status: row.last_check_status, last_check_error: row.last_check_error, last_check_at: row.last_check_at,
    grace_minutes: row.grace_minutes,
  };
  if (args.bot_token !== undefined && args.bot_token !== null && String(args.bot_token).trim() !== '') {
    const token = String(args.bot_token).trim();
    if (!looksLikeBotToken(token)) {
      throw new SettingsError('Это не похоже на токен бота. Он выглядит как 1234567890:AA… — скопируйте его целиком из @BotFather.');
    }
    const clash = clashMessage(db, botIdOfToken(token), { keyPath });
    if (clash) throw new SettingsError(clash);
    patch.bot_token_enc = encryptToken(token, loadOrCreateKey(keyPath));
    patch.bot_token_hint = tokenHint(token);
    patch.bot_username = ''; patch.bot_id = '';
    patch.last_check_status = ''; patch.last_check_error = ''; patch.last_check_at = null;
  }
  if (args.grace_minutes !== undefined && args.grace_minutes !== null && args.grace_minutes !== '') {
    const g = Number(args.grace_minutes);
    if (!Number.isInteger(g) || g < 0 || g > 120) throw new SettingsError('Опоздание считается после 0–120 минут.');
    patch.grace_minutes = g;
  }
  if (patch.enabled && !patch.bot_token_enc) throw new SettingsError('Сначала введите токен бота, потом включайте его.');
  db.prepare(`UPDATE staff_bot_settings SET
      enabled = @enabled, bot_token_enc = @bot_token_enc, bot_token_hint = @bot_token_hint,
      bot_username = @bot_username, bot_id = @bot_id,
      last_check_status = @last_check_status, last_check_error = @last_check_error, last_check_at = @last_check_at,
      grace_minutes = @grace_minutes,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_by = @updated_by
    WHERE id = 1`).run({ ...patch, updated_by: userId });
  return publicSettings(db);
}

export function clearToken(db, userId = null) {
  db.prepare(`UPDATE staff_bot_settings SET
      bot_token_enc = '', bot_token_hint = '', bot_username = '', bot_id = '',
      last_check_status = '', last_check_error = '', last_check_at = NULL, enabled = 0,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_by = ?
    WHERE id = 1`).run(userId);
  return publicSettings(db);
}

export function getDecryptedToken(db, { keyPath } = {}) {
  const row = readSettingsRow(db);
  if (!row || !row.bot_token_enc) return '';
  return decryptToken(row.bot_token_enc, loadOrCreateKey(keyPath));
}

export function recordCheck(db, { ok, error = '', username = '', id = '' }) {
  db.prepare(`UPDATE staff_bot_settings SET
      last_check_status = @status, last_check_error = @error,
      last_check_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
      bot_username = CASE WHEN @ok = 1 THEN @username ELSE bot_username END,
      bot_id = CASE WHEN @ok = 1 THEN @id ELSE bot_id END
    WHERE id = 1`).run({ status: ok ? 'ok' : 'error', error: ok ? '' : String(error || '').slice(0, 500), ok: ok ? 1 : 0, username: String(username || ''), id: String(id || '') });
  return publicSettings(db);
}
