// AI_CHAT_V1 — что зовут опросчики. Ставят задачу и сразу возвращаются: ИИ
// отвечает исполнитель (worker.js), опросчик бота и Meta его не ждёт.
//
// Ни одна функция здесь не бросает: сбой ИИ-очереди не должен ни ронять
// проход опроса Meta (он идёт в транзакции — откатилась бы вся переписка),
// ни оставлять пациента в Telegram без ответа «сообщение получено».
import { enqueueChatJob } from './queue.js';

/** true — сообщение взял ИИ (бот не отвечает «сообщение получено»). */
export function aiTakesTelegramText(db, { chatId, messageId, createdAt, now = Date.now() }) {
  if (!messageId) return false;
  try {
    return enqueueChatJob(db, { channel: 'telegram', chatKey: String(chatId), sourceId: String(messageId), createdAt, now }) !== 'off';
  } catch (e) { console.warn('[ai] telegram hook:', e.message); return false; }
}

export function aiNoteMetaMessage(db, { convRowId, msgId, direction, createdAt, now = Date.now() }) {
  if (direction !== 'in' || !msgId) return 'skip';
  try { return enqueueChatJob(db, { channel: 'meta_dm', chatKey: String(convRowId), sourceId: String(msgId), createdAt, now }); }
  catch (e) { console.warn('[ai] meta hook:', e.message); return 'skip'; }
}

/**
 * Комментарий ставится по НИТКЕ (поправка A2): chat_key — id строки корня,
 * source_id — сам комментарий, на который отвечать. Так два вопроса подряд
 * под одним постом сливаются в один ответ, а отметки «нужен оператор» и
 * проверка «оператор недавно писал» смотрят на всю нитку.
 */
export function aiNoteMetaComment(db, { threadRowId, commentId, isPage, createdAt, now = Date.now() }) {
  if (isPage || !threadRowId || !commentId) return 'skip';
  try { return enqueueChatJob(db, { channel: 'meta_comment', chatKey: String(threadRowId), sourceId: String(commentId), createdAt, now }); }
  catch (e) { console.warn('[ai] meta hook:', e.message); return 'skip'; }
}

/**
 * Для опросчика: комментарий уже записан upsertComment — находим его строку и
 * строку корня нитки. root_id у ответа хранит comment_id корня; у самого корня
 * он пуст. Корня в базе может не оказаться (ответ пришёл раньше родителя) —
 * тогда ниткой считается сам комментарий.
 */
export function aiNoteMetaCommentById(db, commentId, now = Date.now()) {
  try {
    const r = db.prepare('SELECT id, comment_id, root_id, is_page, created_at FROM meta_comments WHERE comment_id = ?').get(String(commentId));
    if (!r) return 'skip';
    const rootKey = r.root_id || r.comment_id;
    const root = db.prepare('SELECT id FROM meta_comments WHERE comment_id = ?').get(rootKey);
    const threadRowId = root ? root.id : r.id;
    return aiNoteMetaComment(db, { threadRowId, commentId: r.comment_id, isPage: r.is_page === 1, createdAt: r.created_at, now });
  } catch (e) { console.warn('[ai] meta hook:', e.message); return 'skip'; }
}
