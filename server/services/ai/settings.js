// AI_CHAT_V1 — переключатель «ИИ отвечает в чатах» и состояние «не может отвечать».
//
// enabled_at — точка отсчёта очереди: опрос Meta после включения приносит и
// старую переписку, и ИИ не должен на неё отвечать (queue.js сравнивает время
// сообщения с enabled_at).
import { controlState } from '../control/state.js';
import { getDataDir } from '../control/config.js';

const BLOCKED = new Set(['', 'limit', 'no_module']);
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// AI_CHAT_V1: «ИИ остановлен» не должен держаться вечно. Лимит сервера
// управления месячный (месяц UTC): с первого числа нового месяца ИИ снова
// может отвечать, и снимать отметку руками никто не догадается — переключатель
// на экране стоит «включён». Поэтому чтение само снимает лимит прошлого месяца
// (и в базе тоже: очередь читает это же состояние).
const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

export function readAiSettings(db, now = Date.now()) {
  const r = db.prepare('SELECT enabled, enabled_at, blocked, blocked_at FROM ai_settings WHERE id = 1').get();
  if (!r) return { enabled: false, enabled_at: null, blocked: '' };
  let blocked = r.blocked || '';
  if (blocked === 'limit') {
    const at = Date.parse(r.blocked_at || '');
    if (!Number.isFinite(at) || monthOf(at) !== monthOf(now)) {
      db.prepare("UPDATE ai_settings SET blocked = '', blocked_at = NULL WHERE id = 1 AND blocked = 'limit'").run();
      blocked = '';
    }
  }
  return { enabled: r.enabled === 1, enabled_at: r.enabled_at || null, blocked };
}

/** Есть ли модуль `ai` в лицензии клиники. Сбой чтения лицензии — «нет». */
export function hasAiModule(db) {
  try { return controlState(db, getDataDir()).has('ai'); } catch { return false; }
}

/**
 * AI_CHAT_V1: «нет модуля» снимается, когда модуль `ai` снова в лицензии
 * (вендор продлил — лицензия пришла со следующей проверкой связи). Лицензию
 * проверяем только при blocked = 'no_module': исполнитель зовёт это каждые
 * 5 секунд. true — отметка снята.
 */
export function clearNoModuleBlock(db, hasModule = hasAiModule) {
  const r = db.prepare('SELECT blocked FROM ai_settings WHERE id = 1').get();
  if (!r || r.blocked !== 'no_module') return false;
  if (!hasModule(db)) return false;
  db.prepare("UPDATE ai_settings SET blocked = '', blocked_at = NULL WHERE id = 1 AND blocked = 'no_module'").run();
  return true;
}

// AI_CHAT_V1: повторное «включить» при уже включённом ИИ точку отсчёта не двигает —
// иначе сообщения, пришедшие между включениями, потерялись бы как «старые».
export function setAiEnabled(db, on, userId = null, at = nowIso()) {
  if (on) {
    db.prepare(`UPDATE ai_settings SET enabled_at = CASE WHEN enabled = 0 OR enabled_at IS NULL THEN ? ELSE enabled_at END,
                            enabled = 1, updated_by = ?, updated_at = ? WHERE id = 1`)
      .run(at, userId, at);
  } else {
    db.prepare(`UPDATE ai_settings SET enabled = 0, updated_by = ?, updated_at = ? WHERE id = 1`).run(userId, at);
  }
  return readAiSettings(db);
}

export function setAiBlocked(db, blocked, at = nowIso()) {
  if (!BLOCKED.has(blocked)) throw new Error('blocked: ' + blocked);
  db.prepare('UPDATE ai_settings SET blocked = ?, blocked_at = ? WHERE id = 1').run(blocked, blocked ? at : null);
}
