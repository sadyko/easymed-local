// AI_CHAT_V1 — что зовут опросчики. Ставят задачу и сразу возвращаются: ИИ
// отвечает исполнитель (worker.js), опросчик бота и Meta его не ждёт.
//
// Ни одна функция здесь не бросает: сбой ИИ-очереди не должен ни ронять
// проход опроса Meta (он идёт в транзакции — откатилась бы вся переписка),
// ни оставлять пациента в Telegram без ответа «сообщение получено».
import { enqueueChatJob } from './queue.js';
import { readAiSettings } from './settings.js';
import { operatorRecent, isFlagged } from './guards.js';

const aiOn = (db) => { const s = readAiSettings(db); return !!s.enabled && !s.blocked; };

/**
 * true — сообщение взял ИИ (бот не отвечает «сообщение получено»).
 *
 * false — всё как до ИИ, задача не создаётся:
 *  - пациент заблокировал бота (blocked_at): исполнитель всё равно не смог бы
 *    ответить и молча закрыл бы задачу — пациент остался бы без ответа вовсе;
 *  - чат ведёт человек: оператор писал недавно или чат отмечен «нужен
 *    оператор». Здесь ИИ не вмешивается, а бот, как раньше, подтверждает
 *    «сообщение получено» — иначе пациент в чате оператора слышал бы тишину.
 */
export function aiTakesTelegramText(db, { chatId, messageId, createdAt, now = Date.now() }) {
  if (!messageId) return false;
  try {
    if (!aiOn(db)) return false;
    const chat = String(chatId);
    const link = db.prepare('SELECT blocked_at FROM telegram_links WHERE chat_id = ? AND revoked_at IS NULL').get(chat);
    if (!link || link.blocked_at) return false;
    if (operatorRecent(db, 'telegram', chat, now) || isFlagged(db, 'telegram', chat)) return false;
    // message_id у Telegram уникален только внутри чата: у двух пациентов он
    // совпадает постоянно. Без chat_id в source_id UNIQUE(channel, source_id)
    // молча отбросил бы сообщение второго пациента как «повтор».
    // AI_CHAT_V1: только 'queued' — ответ придёт от исполнителя. 'dup' (то же
    // сообщение второй раз) и 'old' задачи не создают: ответить некому, и бот,
    // как раньше, подтверждает «сообщение получено».
    return enqueueChatJob(db, { channel: 'telegram', chatKey: chat, sourceId: `${chat}:${messageId}`, createdAt, now }) === 'queued';
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
    // Опрос проходит до 1250 комментариев в минуту: выключенный ИИ (по
    // умолчанию) не должен стоить двух поисков на каждый.
    if (!aiOn(db)) return 'off';
    const r = db.prepare('SELECT id, comment_id, root_id, is_page, is_hidden, created_at FROM meta_comments WHERE comment_id = ?').get(String(commentId));
    // Скрытый комментарий (спам, скрыл сотрудник) — не отвечать на него публично.
    if (!r || r.is_hidden === 1) return 'skip';
    const rootKey = r.root_id || r.comment_id;
    const root = db.prepare('SELECT id FROM meta_comments WHERE comment_id = ?').get(rootKey);
    const threadRowId = root ? root.id : r.id;
    return aiNoteMetaComment(db, { threadRowId, commentId: r.comment_id, isPage: r.is_page === 1, createdAt: r.created_at, now });
  } catch (e) { console.warn('[ai] meta hook:', e.message); return 'skip'; }
}
