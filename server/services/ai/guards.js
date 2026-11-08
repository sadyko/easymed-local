// AI_CHAT_V1 — когда ИИ должен молчать.
//
// «Оператор» — сообщение с sent_by (учётная запись сотрудника). Служебные
// ответы бота (kind 'system') и ответы ИИ (by_ai = 1) идут без
// sent_by и оператором не считаются.
export const OPERATOR_QUIET_MS = 12 * 3600_000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Время последнего сообщения оператора в чате (ISO) или null. */
export function lastOperatorAt(db, channel, chatKey) {
  if (channel === 'telegram') {
    const r = db.prepare(`SELECT MAX(created_at) at FROM telegram_messages WHERE chat_id = ? AND direction = 'out' AND sent_by IS NOT NULL`).get(String(chatKey));
    return r && r.at ? r.at : null;
  }
  if (channel === 'meta_dm') {
    const r = db.prepare(`SELECT MAX(created_at) at FROM meta_messages WHERE conversation_id = ? AND direction = 'out' AND sent_by IS NOT NULL AND (status IS NULL OR status <> 'failed')`).get(Number(chatKey));
    // AI_CHAT_V1: неудавшаяся отправка оператора пациенту не дошла — ИИ не замолкает.
    return r && r.at ? r.at : null;
  }
  if (channel === 'meta_comment') {
    const c = db.prepare('SELECT comment_id, root_id FROM meta_comments WHERE id = ?').get(Number(chatKey));
    if (!c) return null;
    const key = c.root_id || c.comment_id;
    const r = db.prepare(`SELECT MAX(created_at) at FROM meta_comments WHERE (comment_id = ? OR root_id = ?) AND is_page = 1 AND sent_by IS NOT NULL`).get(key, key);
    return r && r.at ? r.at : null;
  }
  return null;
}

export function operatorRecent(db, channel, chatKey, now = Date.now()) {
  const at = lastOperatorAt(db, channel, chatKey);
  return !!at && now - Date.parse(at) < OPERATOR_QUIET_MS;
}

export function flagChat(db, channel, chatKey, reason, now = Date.now()) {
  db.prepare(`INSERT INTO ai_chat_flags (channel, chat_key, reason, flagged_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(channel, chat_key) DO UPDATE SET reason = excluded.reason, flagged_at = excluded.flagged_at`)
    .run(String(channel), String(chatKey), String(reason), iso(now));
}

/** Отметка стоит, пока оператор не написал в чат ПОСЛЕ неё. */
export function isFlagged(db, channel, chatKey) {
  const f = db.prepare('SELECT flagged_at FROM ai_chat_flags WHERE channel = ? AND chat_key = ?').get(String(channel), String(chatKey));
  if (!f) return false;
  const op = lastOperatorAt(db, channel, chatKey);
  return !(op && op >= f.flagged_at);
}

/** Чаты, ждущие оператора, — для меток в экранах чатов. */
export function flaggedChats(db) {
  return db.prepare('SELECT channel, chat_key, reason, flagged_at FROM ai_chat_flags ORDER BY flagged_at DESC').all()
    .filter((f) => isFlagged(db, f.channel, f.chat_key));
}
