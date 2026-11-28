// DAILY_REPORT_BOT_V1 (2026-11-13) — настройки бота «Отчёт в Telegram»: одна
// строка daily_report_settings (id = 1, мигр. 286). Зеркало rep-bot/settings.js;
// своё — группа (chat_id), время отправки, «за какой день» и блоки отчёта.
//
// Токен зашифрован тем же ключом data/.telegram-key, что у трёх других ботов, и
// обратно на экран уходит только хвост (tokenHint). Бот обязан быть ОТДЕЛЬНЫМ:
// поиск группы читает getUpdates, и на токене пациентского бота это отбирало бы
// у него сообщения пациентов.
import { encryptToken, decryptToken, loadOrCreateKey, looksLikeBotToken, tokenHint } from '../telegram/crypto.js';
import { botIdOfToken, storedBotId } from '../doctor-bot/settings.js';

export class SettingsError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Блоки отчёта по порядку; их имена — report.js SECTION_TITLES.
 *  DAILY_REPORT_FORMAT_V2 (2026-11-14, владелец со снимком образца: «first
 *  there should be total income then by cashier, then by coverage type») —
 *  порядок: принято (со способами оплаты), по кассирам, по типу покрытия,
 *  по отделениям, по группам услуг, пациенты, колл-центр; дальше — по желанию. */
export const SECTIONS = ['cash', 'cashiers', 'coverage', 'departments', 'groups', 'patients', 'crm', 'debt', 'calls', 'doctors'];
/** Блоки первого формата → их место во втором (сохранённые списки не теряются). */
const LEGACY = { methods: ['cash'], directions: ['departments', 'groups'], clinical: ['patients'] };
/** Ядро образца владельца: список первого формата получает его целиком. */
const CORE = ['cash', 'cashiers', 'coverage', 'departments', 'groups', 'patients', 'crm'];

const OTHER_BOTS = [
  ['telegram_settings', 'пациентского бота'],
  ['doctor_bot_settings', 'бота для врачей-источников'],
  ['rep_bot_settings', 'бота для медпредставителей'],
  ['staff_bot_settings', 'бота сотрудников'],   // STAFF_ATTENDANCE_V1
];

/** Отказ, если id — номер другого бота клиники; '' — бот свой. */
export function clashMessage(db, id, opts = {}) {
  const mine = String(id == null ? '' : id).trim();
  if (!mine) return '';
  for (const [table, what] of OTHER_BOTS) {
    if (mine === storedBotId(db, table, opts)) {
      return `Это токен ${what}. Для отчёта нужен ДРУГОЙ бот: создайте его в @BotFather (команда /newbot) и вставьте его токен.`;
    }
  }
  return '';
}

export function readSettingsRow(db) {
  return db.prepare('SELECT * FROM daily_report_settings WHERE id = 1').get();
}

/** Включённые блоки: пустой или битый список — ядро владельца (CORE).
 *  DAILY_REPORT_OWNER_V1 (2026-11-14, владелец со снимком отчёта: «make it more
 *  appropriate to owner, it is now too detailed») — долг, звонки и врачи по
 *  умолчанию не шлются; их можно отметить на экране настроек. */
export function sectionsOf(raw) {
  let list = [];
  try { list = JSON.parse(raw || '[]'); } catch (_) { list = []; }
  list = Array.isArray(list) ? list : [];
  // DAILY_REPORT_FORMAT_V2 — список первого формата: старые ключи переводятся,
  // и ядро нового формата включается целиком (иначе новые блоки — кассиры,
  // покрытие — у уже настроенной клиники не появились бы никогда).
  if (list.some((k) => LEGACY[k])) list = [...list.flatMap((k) => LEGACY[k] || [k]), ...CORE];
  list = list.filter((k) => SECTIONS.includes(k));
  return list.length ? SECTIONS.filter((k) => list.includes(k)) : [...CORE];
}

export function publicSettings(db) {
  const row = readSettingsRow(db) || {};
  return {
    enabled: !!row.enabled,
    has_token: !!row.bot_token_enc,
    token_hint: row.bot_token_hint || '',
    bot_username: row.bot_username || '',
    bot_id: row.bot_id || '',
    chat_id: row.chat_id || '',
    chat_title: row.chat_title || '',
    send_time: row.send_time || '21:00',
    period: row.period || 'today',
    sections: sectionsOf(row.sections),
    all_sections: [...SECTIONS],
    last_sent_day: row.last_sent_day || null,
    last_sent_at: row.last_sent_at || null,
    last_error: row.last_error || '',
    updated_at: row.updated_at || null,
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Группа и супергруппа — отрицательный номер, канал — тоже; @имя публичного
// чата Telegram принимает как chat_id. Всё прочее — опечатка, а не группа.
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,64})$/;

/**
 * Сохранить то, что пришло: токен (новый сбрасывает имя бота), группу, время,
 * «за какой день», блоки, выключатель. Включить без токена и группы нельзя.
 */
export function saveSettings(db, args = {}, userId = null, { keyPath } = {}) {
  const row = readSettingsRow(db);
  if (!row) throw new SettingsError('Настройки отчёта не инициализированы.', 500);
  const a = args || {};
  const patch = {
    enabled: a.enabled === undefined ? row.enabled : (a.enabled ? 1 : 0),
    bot_token_enc: row.bot_token_enc, bot_token_hint: row.bot_token_hint,
    bot_username: row.bot_username, bot_id: row.bot_id,
    chat_id: row.chat_id, chat_title: row.chat_title,
    send_time: row.send_time, period: row.period, sections: row.sections,
  };
  if (a.bot_token !== undefined && a.bot_token !== null && String(a.bot_token).trim() !== '') {
    const token = String(a.bot_token).trim();
    if (!looksLikeBotToken(token)) {
      throw new SettingsError('Это не похоже на токен бота. Он выглядит как 1234567890:AA… — скопируйте его целиком из @BotFather.');
    }
    const clash = clashMessage(db, botIdOfToken(token), { keyPath });
    if (clash) throw new SettingsError(clash);
    patch.bot_token_enc = encryptToken(token, loadOrCreateKey(keyPath));
    patch.bot_token_hint = tokenHint(token);
    patch.bot_username = ''; patch.bot_id = '';
  }
  if (a.chat_id !== undefined) {
    const chat = String(a.chat_id == null ? '' : a.chat_id).trim();
    if (chat && !CHAT_RE.test(chat)) throw new SettingsError('Номер группы не разобран. У группы он отрицательный, например -1001234567890 — нажмите «Найти группу».');
    patch.chat_id = chat;
    patch.chat_title = chat ? String(a.chat_title == null ? (chat === row.chat_id ? row.chat_title : '') : a.chat_title).slice(0, 200) : '';
  }
  if (a.send_time !== undefined) {
    const t = String(a.send_time || '').trim();
    if (!TIME_RE.test(t)) throw new SettingsError('Время отправки — в виде ЧЧ:ММ, например 21:00.');
    patch.send_time = t;
  }
  if (a.period !== undefined) {
    if (!['today', 'yesterday'].includes(a.period)) throw new SettingsError('«За какой день» — сегодня или вчера.');
    patch.period = a.period;
  }
  if (a.sections !== undefined) {
    const list = Array.isArray(a.sections) ? a.sections.filter((k) => SECTIONS.includes(k)) : [];
    if (!list.length) throw new SettingsError('Отметьте хотя бы один блок отчёта.');
    patch.sections = JSON.stringify(SECTIONS.filter((k) => list.includes(k)));
  }
  if (patch.enabled && !patch.bot_token_enc) throw new SettingsError('Сначала введите токен бота, потом включайте отчёт.');
  if (patch.enabled && !patch.chat_id) throw new SettingsError('Сначала выберите группу, куда слать отчёт.');
  db.prepare(`UPDATE daily_report_settings SET
      enabled = @enabled, bot_token_enc = @bot_token_enc, bot_token_hint = @bot_token_hint,
      bot_username = @bot_username, bot_id = @bot_id, chat_id = @chat_id, chat_title = @chat_title,
      send_time = @send_time, period = @period, sections = @sections,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_by = @updated_by
    WHERE id = 1`).run({ ...patch, updated_by: userId });
  return publicSettings(db);
}

/** Удалить токен: отчёт выключается, группа остаётся (новый бот — та же группа). */
export function clearToken(db, userId = null) {
  db.prepare(`UPDATE daily_report_settings SET
      bot_token_enc = '', bot_token_hint = '', bot_username = '', bot_id = '', enabled = 0,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_by = ?
    WHERE id = 1`).run(userId);
  return publicSettings(db);
}

export function getDecryptedToken(db, { keyPath } = {}) {
  const row = readSettingsRow(db);
  if (!row || !row.bot_token_enc) return '';
  return decryptToken(row.bot_token_enc, loadOrCreateKey(keyPath));
}

export function recordBot(db, { username = '', id = '' }) {
  db.prepare('UPDATE daily_report_settings SET bot_username = ?, bot_id = ? WHERE id = 1')
    .run(String(username || ''), String(id || ''));
  return publicSettings(db);
}

/** Итог попытки: удача по расписанию ставит день (второй раз за день не шлём), сбой — текст. */
export function recordAttempt(db, { ok, day = null, error = '', scheduled = false }) {
  db.prepare(`UPDATE daily_report_settings SET
      last_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
      last_error = @error,
      last_sent_at = CASE WHEN @ok = 1 THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') ELSE last_sent_at END,
      last_sent_day = CASE WHEN @ok = 1 AND @scheduled = 1 THEN @day ELSE last_sent_day END
    WHERE id = 1`).run({ ok: ok ? 1 : 0, scheduled: scheduled ? 1 : 0, day, error: ok ? '' : String(error || '').slice(0, 500) });
  return publicSettings(db);
}
