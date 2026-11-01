// SMS_INFORM_V1 — настройки SMS (таблица sms_settings, одна строка id = 1).
//
// Правила — те же, что у meta/settings.js:
//   * пароль Play Mobile хранится ТОЛЬКО шифртекстом через api/secret-box.js;
//     publicSettings отдаёт признак password_set и хвост, никогда — значение;
//     расшифровка (connectionSettings) — только серверу;
//   * saveSettings — заплатка: отсутствующее поле значит «оставить как есть»,
//     пустой пароль — тоже «оставить» (экран не получает пароль обратно);
//   * включить отправку без адреса, логина, пароля и отправителя нельзя —
//     это молча неработающая интеграция.

import { loadKek, seal, unseal, tailOf } from '../api/secret-box.js';

export class SettingsError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

export function readSettingsRow(db) {
  try { return db.prepare('SELECT * FROM sms_settings WHERE id = 1').get() || null; }
  catch { return null; }   // миграция ещё не прошла — тише, чем 500
}

/** Всё, что можно показать на экране. Шифртекста здесь нет по построению. */
export function publicSettings(db) {
  const row = readSettingsRow(db) || {};
  return {
    enabled: !!row.enabled,
    base_url: row.base_url || '',
    login: row.login || '',
    password_set: !!row.password_sealed,
    password_tail: row.password_tail || '',
    originator: row.originator || '',
    updated_at: row.updated_at || null,
  };
}

function complete(s) {
  return !!(s.base_url && s.login && s.password_set && s.originator);
}

// Сообщения — целыми фразами: словарь экрана переводит только целые строки.
export function saveSettings(db, args, userId, { kekPath } = {}) {
  const a = args || {};
  const prev = publicSettings(db);
  const next = { ...prev };
  if (a.base_url !== undefined) {
    const u = String(a.base_url || '').trim();
    if (u && !/^https?:\/\/[^\s/]+/i.test(u)) throw new SettingsError('Адрес Play Mobile должен начинаться с http:// или https://.');
    next.base_url = u.slice(0, 300);
  }
  if (a.login !== undefined) next.login = String(a.login || '').trim().slice(0, 100);
  if (a.originator !== undefined) {
    const o = String(a.originator || '').trim();
    if (o.length > 20) throw new SettingsError('Имя отправителя — не длиннее 20 символов.');
    next.originator = o;
  }
  let sealed = null;
  if (typeof a.password === 'string' && a.password.trim()) {
    const kek = loadKek({ kekPath, create: true });   // файл ключа — до записи в базу
    sealed = { v: seal(a.password.trim(), kek), tail: tailOf(a.password.trim()) };
    next.password_set = true;
  }
  if (a.enabled !== undefined) next.enabled = !!a.enabled;
  if (next.enabled && !complete(next)) {
    throw new SettingsError('Чтобы включить SMS, заполните адрес, логин, пароль и имя отправителя.');
  }
  db.prepare(`UPDATE sms_settings SET enabled = @enabled, base_url = @base_url, login = @login, originator = @originator,
      password_sealed = COALESCE(@ps, password_sealed), password_tail = COALESCE(@pt, password_tail),
      updated_at = ${NOW_SQL}, updated_by = @uid WHERE id = 1`).run({
    enabled: next.enabled ? 1 : 0, base_url: next.base_url, login: next.login, originator: next.originator,
    ps: sealed ? sealed.v : null, pt: sealed ? sealed.tail : null, uid: userId || null,
  });
  return publicSettings(db);
}

/** Стереть пароль: отправка выключается — без пароля она не работает. */
export function clearPassword(db, userId) {
  db.prepare(`UPDATE sms_settings SET password_sealed = '', password_tail = '', enabled = 0,
      updated_at = ${NOW_SQL}, updated_by = ? WHERE id = 1`).run(userId || null);
  return publicSettings(db);
}

/** Только для сервера: настройки с расшифрованным паролем. */
export function connectionSettings(db, { kekPath } = {}) {
  const row = readSettingsRow(db) || {};
  const pub = publicSettings(db);
  const password = row.password_sealed ? unseal(row.password_sealed, loadKek({ kekPath })) : '';
  return { ...pub, password, ready: complete(pub) };
}
