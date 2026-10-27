// REFERRALS_CRM_V1 (2026-10-26) — настройки Telegram-бота для врачей-источников:
// одна строка doctor_bot_settings (id = 1), токен зашифрован тем же ключом
// data/.telegram-key, что у пациентского бота (telegram/crypto.js). Зеркало
// telegram/settings.js без того, что здесь не нужно (виды документов,
// приветствие, push).
import { encryptToken, decryptToken, loadOrCreateKey, looksLikeBotToken, tokenHint } from '../telegram/crypto.js';

export class SettingsError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function readSettingsRow(db) {
  return db.prepare('SELECT * FROM doctor_bot_settings WHERE id = 1').get();
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
    updated_at: row.updated_at || null,
  };
}

/**
 * Сохранить токен и/или выключатель. Новый токен сбрасывает имя бота и
 * последнюю проверку — их заново запишет проверка связи. Включить бота без
 * токена нельзя: поллеру нечем было бы спрашивать Telegram.
 */
export function saveSettings(db, args = {}, userId = null, { keyPath } = {}) {
  const row = readSettingsRow(db);
  if (!row) throw new SettingsError('Настройки бота для врачей не инициализированы.', 500);
  const patch = {
    enabled: args.enabled === undefined ? row.enabled : (args.enabled ? 1 : 0),
    bot_token_enc: row.bot_token_enc, bot_token_hint: row.bot_token_hint,
    bot_username: row.bot_username, bot_id: row.bot_id,
    last_check_status: row.last_check_status, last_check_error: row.last_check_error, last_check_at: row.last_check_at,
  };
  if (args.bot_token !== undefined && args.bot_token !== null && String(args.bot_token).trim() !== '') {
    const token = String(args.bot_token).trim();
    if (!looksLikeBotToken(token)) {
      throw new SettingsError('Это не похоже на токен бота. Он выглядит как 1234567890:AA… — скопируйте его целиком из @BotFather.');
    }
    patch.bot_token_enc = encryptToken(token, loadOrCreateKey(keyPath));
    patch.bot_token_hint = tokenHint(token);
    patch.bot_username = ''; patch.bot_id = '';
    patch.last_check_status = ''; patch.last_check_error = ''; patch.last_check_at = null;
  }
  if (patch.enabled && !patch.bot_token_enc) throw new SettingsError('Сначала введите токен бота, потом включайте его.');
  db.prepare(`UPDATE doctor_bot_settings SET
      enabled = @enabled, bot_token_enc = @bot_token_enc, bot_token_hint = @bot_token_hint,
      bot_username = @bot_username, bot_id = @bot_id,
      last_check_status = @last_check_status, last_check_error = @last_check_error, last_check_at = @last_check_at,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_by = @updated_by
    WHERE id = 1`).run({ ...patch, updated_by: userId });
  return publicSettings(db);
}

export function clearToken(db, userId = null) {
  db.prepare(`UPDATE doctor_bot_settings SET
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
  db.prepare(`UPDATE doctor_bot_settings SET
      last_check_status = @status, last_check_error = @error,
      last_check_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
      bot_username = CASE WHEN @ok = 1 THEN @username ELSE bot_username END,
      bot_id = CASE WHEN @ok = 1 THEN @id ELSE bot_id END
    WHERE id = 1`).run({ status: ok ? 'ok' : 'error', error: ok ? '' : String(error || '').slice(0, 500), ok: ok ? 1 : 0, username: String(username || ''), id: String(id || '') });
  return publicSettings(db);
}
