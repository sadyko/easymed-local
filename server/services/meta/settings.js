// META_LEADS_V1_STORE — настройки подключения Meta (таблица meta_settings,
// одна строка id = 1).
//
// Правила — те же, что у telephony/settings.js и telegram/settings.js:
//   * токен (и токен страницы, если Meta выдала отдельный) хранится ТОЛЬКО
//     шифртекстом через api/secret-box.js — тем же ключом клиники, что ключи
//     подключений API; publicSettings отдаёт признак token_set и хвост, и
//     никогда — значение; расшифровка (getTokens) доступна только серверу;
//   * saveSettings — заплатка: отсутствующее поле значит «оставить как есть»,
//     чтобы экран мог сохранить один переключатель, не пересылая остальное;
//   * включить опрос без токена нельзя — это молча неработающая интеграция;
//   * список форм помнит снятые галочки между проверками связи: повторная
//     проверка обновляет имена и счётчики, не возвращая снятые формы в опрос.

import { loadKek, seal, unseal, tailOf } from '../api/secret-box.js';

export class SettingsError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const FORMS_MODES = new Set(['all', 'selected']);

export function readSettingsRow(db) {
  try { return db.prepare('SELECT * FROM meta_settings WHERE id = 1').get() || null; }
  catch { return null; }   // миграция ещё не прошла — тише, чем 500
}

function parseForms(json) {
  try {
    const arr = JSON.parse(json || '[]');
    return Array.isArray(arr) ? arr.filter((f) => f && typeof f === 'object' && f.id != null).map((f) => ({
      id: String(f.id), name: String(f.name || ''), status: String(f.status || ''),
      leads_count: Number(f.leads_count) || 0, selected: f.selected !== false && f.selected !== 0,
    })) : [];
  } catch { return []; }
}

/** Всё, что можно показать на экране. Шифртекста здесь нет по построению. */
export function publicSettings(db) {
  const row = readSettingsRow(db) || {};
  return {
    enabled: !!row.enabled,
    token_set: !!row.token_sealed,
    token_tail: row.token_tail || '',
    page_id: row.page_id || '',
    page_name: row.page_name || '',
    token_checked_at: row.token_checked_at || null,
    token_expires_at: row.token_expires_at || null,
    forms_mode: row.forms_mode || 'all',
    forms: parseForms(row.forms_json),
    poll_minutes: Number(row.poll_minutes) || 2,
    since_ts: Number(row.since_ts) || 0,
    last_poll_at: row.last_poll_at || null,
    last_ok_at: row.last_ok_at || null,
    last_error: row.last_error || '',
    updated_at: row.updated_at || null,
  };
}

/**
 * Проверенное подключение: токены — печатью, страница и формы — открыто.
 * Снятые галочки прежнего списка переживают обновление; форма, которой у
 * страницы больше нет, из списка уходит (её нечего опрашивать).
 */
export function storeConnection(db, { token, pageToken = '', page, forms = [], expiresAt = null }, { kekPath } = {}) {
  if (typeof token !== 'string' || !token.trim()) throw new SettingsError('Пустой токен не сохраняется.');
  const kek = loadKek({ kekPath, create: true });   // файл ключа — до записи в базу
  const prev = parseForms((readSettingsRow(db) || {}).forms_json);
  const keep = new Map(prev.map((f) => [f.id, f.selected]));
  const merged = (Array.isArray(forms) ? forms : []).filter((f) => f && f.id != null).map((f) => ({
    id: String(f.id), name: String(f.name || ''), status: String(f.status || ''),
    leads_count: Number(f.leads_count) || 0,
    selected: keep.has(String(f.id)) ? keep.get(String(f.id)) : true,
  }));
  db.prepare(`UPDATE meta_settings SET
      token_sealed = @token_sealed, token_tail = @token_tail, page_token_sealed = @page_token_sealed,
      page_id = @page_id, page_name = @page_name, token_checked_at = ${NOW_SQL}, token_expires_at = @expires,
      forms_json = @forms_json, updated_at = ${NOW_SQL}
    WHERE id = 1`).run({
    token_sealed: seal(token.trim(), kek), token_tail: tailOf(token.trim()),
    page_token_sealed: pageToken ? seal(String(pageToken), kek) : '',
    page_id: String((page && page.id) || ''), page_name: String((page && page.name) || '').slice(0, 200),
    expires: expiresAt || null,
    forms_json: JSON.stringify(merged),
  });
  return publicSettings(db);
}

/** Только для сервера: расшифрованные токены. Без токена — пустые строки, не ошибка. */
export function getTokens(db, { kekPath } = {}) {
  const row = readSettingsRow(db) || {};
  if (!row.token_sealed) return { token: '', pageToken: '' };
  const kek = loadKek({ kekPath });
  return {
    token: unseal(row.token_sealed, kek),
    pageToken: row.page_token_sealed ? unseal(row.page_token_sealed, kek) : '',
  };
}

// Сообщение — целой фразой, а не сборкой из кусков: словарь экрана переводит
// только целые строки (server/i18n-server-messages.test.js).
function intAtLeast(v, min, message) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new SettingsError(message);
  return n;
}

/** Заплатка настроек. Возвращает publicSettings. */
export function saveSettings(db, patch, userId = null) {
  const a = patch && typeof patch === 'object' ? patch : {};
  const row = readSettingsRow(db);
  if (!row) throw new SettingsError('Настройки Meta недоступны: база не обновлена.', 500);
  const set = { updated_by: userId };
  if ('poll_minutes' in a) set.poll_minutes = intAtLeast(a.poll_minutes, 1, 'Период опроса в минутах — целое число, не меньше 1.');
  if ('forms_mode' in a) {
    if (!FORMS_MODES.has(a.forms_mode)) throw new SettingsError('Режим форм — «все» или «выбранные».');
    set.forms_mode = a.forms_mode;
  }
  if ('forms' in a) {
    if (!Array.isArray(a.forms)) throw new SettingsError('Список форм — массив.');
    const sel = new Map(a.forms.filter((f) => f && f.id != null).map((f) => [String(f.id), f.selected !== false && f.selected !== 0]));
    const forms = parseForms(row.forms_json).map((f) => (sel.has(f.id) ? { ...f, selected: sel.get(f.id) } : f));
    set.forms_json = JSON.stringify(forms);
  }
  if ('enabled' in a) {
    const on = !!a.enabled;
    if (on && !row.token_sealed) throw new SettingsError('Сначала сохраните токен доступа Meta — без него заявки забирать неоткуда.');
    set.enabled = on ? 1 : 0;
    // Включили — забираем с этого момента, а не историю за 90 дней без спроса.
    if (on && !row.enabled && !(Number(row.since_ts) > 0)) set.since_ts = Math.floor(Date.now() / 1000);
    if (on) set.last_error = '';
  }
  const cols = Object.keys(set);
  db.prepare(`UPDATE meta_settings SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = ${NOW_SQL} WHERE id = 1`).run(set);
  return publicSettings(db);
}

/** Какие формы опрашивать сейчас: режим «все» — все формы страницы, «выбранные» — только с галочкой. */
export function formsToPoll(db) {
  const row = readSettingsRow(db) || {};
  const forms = parseForms(row.forms_json);
  return row.forms_mode === 'selected' ? forms.filter((f) => f.selected) : forms;
}

/** Удалить токен: интеграция выключается, страница и формы забываются. Журнал заявок остаётся. */
export function clearToken(db, userId = null) {
  db.prepare(`UPDATE meta_settings SET
      enabled = 0, token_sealed = '', token_tail = '', page_token_sealed = '', page_id = '', page_name = '',
      token_checked_at = NULL, token_expires_at = NULL, forms_json = '[]', last_error = '',
      updated_by = @userId, updated_at = ${NOW_SQL}
    WHERE id = 1`).run({ userId });
  return publicSettings(db);
}

/**
 * След каждого прохода опроса: last_poll_at — «цикл жив», last_error — слово из
 * словаря graph.js ('' — всё хорошо). Удача двигает курсор и пишет last_ok_at.
 * bad_token выключает опрос: долбить Meta недействительным токеном бессмысленно
 * и ведёт к блокировке приложения; новый токен включит обратно.
 */
export function recordPoll(db, { ok, error = '', sinceTs = null } = {}) {
  // Удача с оговоркой (например 'truncated' — забраны только самые свежие)
  // двигает курсор, но слово оставляет, чтобы экран о ней сказал.
  const word = String(error || (ok ? '' : 'server_error')).slice(0, 40);
  db.prepare(`UPDATE meta_settings SET
      last_poll_at = ${NOW_SQL},
      last_ok_at = CASE WHEN @ok THEN ${NOW_SQL} ELSE last_ok_at END,
      since_ts = CASE WHEN @ok AND @since IS NOT NULL AND @since > since_ts THEN @since ELSE since_ts END,
      last_error = @word,
      enabled = CASE WHEN @word = 'bad_token' THEN 0 ELSE enabled END
    WHERE id = 1`).run({ ok: ok ? 1 : 0, since: sinceTs == null ? null : Number(sinceTs), word });
}

/** Сдвинуть курсор назад на N дней (кнопка «Забрать заявки за последние N дней»). */
export function rewindSince(db, days) {
  const d = intAtLeast(days, 1, 'Число дней — целое число от 1 до 90.');
  if (d > 90) throw new SettingsError('Meta хранит заявки не дольше 90 дней.');
  const ts = Math.floor(Date.now() / 1000) - d * 86400;
  db.prepare(`UPDATE meta_settings SET since_ts = @ts, updated_at = ${NOW_SQL} WHERE id = 1`).run({ ts });
  return ts;
}
