// AI_CHAT_V1 — переключатель «ИИ отвечает в чатах» и состояние «не может отвечать».
//
// enabled_at — точка отсчёта очереди: опрос Meta после включения приносит и
// старую переписку, и ИИ не должен на неё отвечать (queue.js сравнивает время
// сообщения с enabled_at).
const BLOCKED = new Set(['', 'limit', 'no_module']);
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export function readAiSettings(db) {
  const r = db.prepare('SELECT enabled, enabled_at, blocked FROM ai_settings WHERE id = 1').get();
  if (!r) return { enabled: false, enabled_at: null, blocked: '' };
  return { enabled: r.enabled === 1, enabled_at: r.enabled_at || null, blocked: r.blocked || '' };
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
