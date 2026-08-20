// TELEGRAM_BOT_V1 — чтение и запись настроек бота.
//
// Здесь только база и шифрование: проверка роли живёт в
// server/services/rpc/telegram.js, на границе RPC, где в этом проекте стоят
// все остальные гарды. Так этот модуль можно звать и из фонового опросника,
// у которого никакого `user` нет.

import { loadOrCreateKey, encryptToken, decryptToken, looksLikeBotToken, tokenHint } from './crypto.js';

export const DOC_KINDS = ['lab', 'conclusion', 'diag', 'invoice', 'file'];

export function readSettingsRow(db) {
  return db.prepare('SELECT * FROM telegram_settings WHERE id = 1').get();
}

// Единственная форма настроек, которая уходит в браузер. Токена здесь нет и
// быть не может — только его хвост, чтобы администратор узнал сохранённый
// токен, не увидев его.
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
    doc_kinds: String(row.doc_kinds || '').split(',').filter(Boolean),
    push_enabled: !!row.push_enabled,
    welcome_text: row.welcome_text || '',
    chrome_path: row.chrome_path || '',
    updated_at: row.updated_at || null,
  };
}

export class SettingsError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Сохранение настроек. Токен необязателен: UI присылает его только когда
// администратор вводит новый, поэтому обычное сохранение галочек НЕ должно
// стирать уже сохранённый токен (частая ошибка таких форм — пустое поле
// «пароль» затирает пароль).
export function saveSettings(db, args = {}, userId = null, { keyPath } = {}) {
  const row = readSettingsRow(db);
  if (!row) throw new SettingsError('Настройки бота не инициализированы.', 500);

  const patch = {
    enabled: args.enabled === undefined ? row.enabled : (args.enabled ? 1 : 0),
    push_enabled: args.push_enabled === undefined ? row.push_enabled : (args.push_enabled ? 1 : 0),
    welcome_text: args.welcome_text === undefined ? row.welcome_text : String(args.welcome_text).slice(0, 1000),
    chrome_path: args.chrome_path === undefined ? row.chrome_path : String(args.chrome_path).slice(0, 500),
    doc_kinds: row.doc_kinds,
    bot_token_enc: row.bot_token_enc,
    bot_token_hint: row.bot_token_hint,
    bot_username: row.bot_username,
    bot_id: row.bot_id,
    last_check_status: row.last_check_status,
    last_check_error: row.last_check_error,
    last_check_at: row.last_check_at,
  };

  if (args.doc_kinds !== undefined) {
    const kinds = Array.isArray(args.doc_kinds) ? args.doc_kinds : String(args.doc_kinds).split(',');
    const clean = [...new Set(kinds.map((k) => String(k).trim()).filter(Boolean))];
    const bad = clean.filter((k) => !DOC_KINDS.includes(k));
    if (bad.length) throw new SettingsError('Неизвестный вид документа: ' + bad.join(', '));
    patch.doc_kinds = clean.join(',');
  }

  // Токен: '' (или null) означает «не трогать», строка — «заменить».
  // Явное удаление делает clearToken().
  if (args.bot_token !== undefined && args.bot_token !== null && String(args.bot_token).trim() !== '') {
    const token = String(args.bot_token).trim();
    if (!looksLikeBotToken(token)) {
      throw new SettingsError('Это не похоже на токен бота. Он выглядит как 1234567890:AA… — скопируйте его целиком из @BotFather.');
    }
    patch.bot_token_enc = encryptToken(token, loadOrCreateKey(keyPath));
    patch.bot_token_hint = tokenHint(token);
    // Новый токен — это, возможно, другой бот. Всё, что знали о старом,
    // перестаёт быть правдой до следующей проверки связи.
    patch.bot_username = '';
    patch.bot_id = '';
    patch.last_check_status = '';
    patch.last_check_error = '';
    patch.last_check_at = null;
  }

  // Включить бота без токена нельзя: иначе «включено» в интерфейсе означало бы
  // работающего бота, а по факту опросник молчал бы.
  if (patch.enabled && !patch.bot_token_enc) {
    throw new SettingsError('Сначала введите токен бота, потом включайте его.');
  }

  db.prepare(`UPDATE telegram_settings SET
      enabled = @enabled, push_enabled = @push_enabled, welcome_text = @welcome_text,
      chrome_path = @chrome_path, doc_kinds = @doc_kinds,
      bot_token_enc = @bot_token_enc, bot_token_hint = @bot_token_hint,
      bot_username = @bot_username, bot_id = @bot_id,
      last_check_status = @last_check_status, last_check_error = @last_check_error,
      last_check_at = @last_check_at,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_by = @updated_by
    WHERE id = 1`).run({ ...patch, updated_by: userId });

  return publicSettings(db);
}

// Удаление токена выключает бота: работающий бот без токена — это состояние,
// в котором интерфейс врал бы администратору.
export function clearToken(db, userId = null) {
  db.prepare(`UPDATE telegram_settings SET
      bot_token_enc = '', bot_token_hint = '', bot_username = '', bot_id = '',
      last_check_status = '', last_check_error = '', last_check_at = NULL,
      enabled = 0,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_by = ?
    WHERE id = 1`).run(userId);
  return publicSettings(db);
}

// Расшифрованный токен — только для сервера: опросник и проверка связи.
// Возвращает '' если токен не задан.
export function getDecryptedToken(db, { keyPath } = {}) {
  const row = readSettingsRow(db);
  if (!row || !row.bot_token_enc) return '';
  return decryptToken(row.bot_token_enc, loadOrCreateKey(keyPath));
}

// Результат проверки связи ложится в ту же строку, чтобы интерфейс после
// перезагрузки страницы показывал состояние, а не пустоту.
export function recordCheck(db, { ok, error = '', username = '', id = '' }) {
  db.prepare(`UPDATE telegram_settings SET
      last_check_status = @status, last_check_error = @error,
      last_check_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
      bot_username = CASE WHEN @ok = 1 THEN @username ELSE bot_username END,
      bot_id = CASE WHEN @ok = 1 THEN @id ELSE bot_id END
    WHERE id = 1`).run({
    status: ok ? 'ok' : 'error',
    error: ok ? '' : String(error || '').slice(0, 500),
    ok: ok ? 1 : 0,
    username, id,
  });
  return publicSettings(db);
}
