// AI_CHAT_V1 — очередь ответов ИИ. Опросчики ставят задачу и не ждут ИИ;
// исполнитель (worker.js) забирает по одной.
//
// Правила постановки: ИИ включён и не заблокирован; сообщение пришло ПОСЛЕ
// включения и не старше 30 минут (опрос Meta приносит историю); одно входящее
// сообщение — одна задача (UNIQUE channel+source_id).
//
// Перезапуск: 'working' — ответ ещё не отправлялся, задачу можно повторить;
// 'sending' — неизвестно, ушёл ли ответ: повторять НЕЛЬЗЯ (пациент получил бы
// его дважды), чат передаётся оператору.
import { readAiSettings } from './settings.js';

export const MAX_AGE_MS = 30 * 60_000;
export const GIVE_UP_MS = 10 * 60_000;
const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 240_000];
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function enqueueChatJob(db, { channel, chatKey, sourceId, createdAt, now = Date.now() }) {
  const s = readAiSettings(db);
  if (!s.enabled || s.blocked) return 'off';
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created) || !s.enabled_at || created < Date.parse(s.enabled_at) || now - created > MAX_AGE_MS) return 'old';
  // created_at пишется явно (а не часами SQLite): по нему считаются 10 минут
  // до «сдаёмся», и тесты задают время сами.
  const r = db.prepare(`INSERT INTO ai_chat_jobs (channel, chat_key, source_id, next_at, created_at) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(channel, source_id) DO NOTHING`)
    .run(String(channel), String(chatKey), String(sourceId), iso(now), iso(now));
  return r.changes > 0 ? 'queued' : 'dup';
}

export function claimNextJob(db, now = Date.now()) {
  return db.transaction(() => {
    const j = db.prepare(`SELECT * FROM ai_chat_jobs WHERE status = 'queued' AND next_at <= ? ORDER BY id LIMIT 1`).get(iso(now));
    if (!j) return null;
    db.prepare(`UPDATE ai_chat_jobs SET status = 'working', attempts = attempts + 1 WHERE id = ?`).run(j.id);
    // Несколько сообщений подряд — один ответ на все.
    db.prepare(`UPDATE ai_chat_jobs SET status = 'merged', finished_at = ? WHERE channel = ? AND chat_key = ? AND status = 'queued' AND id <> ?`)
      .run(iso(now), j.channel, j.chat_key, j.id);
    return db.prepare('SELECT * FROM ai_chat_jobs WHERE id = ?').get(j.id);
  })();
}

export function markSending(db, id) {
  db.prepare(`UPDATE ai_chat_jobs SET status = 'sending' WHERE id = ?`).run(id);
}

export function finishJob(db, id, status, outcome = '', now = Date.now()) {
  db.prepare(`UPDATE ai_chat_jobs SET status = ?, outcome = ?, finished_at = ? WHERE id = ?`).run(status, outcome, iso(now), id);
}

/** 'retry' — поставлена снова с паузой; 'gave_up' — 10 минут без ответа, задача закрыта. */
export function retryJob(db, id, now = Date.now()) {
  const j = db.prepare('SELECT created_at, attempts FROM ai_chat_jobs WHERE id = ?').get(id);
  if (!j) return 'gave_up';
  if (now - Date.parse(j.created_at) >= GIVE_UP_MS) {
    finishJob(db, id, 'failed', 'timeout', now);
    return 'gave_up';
  }
  const wait = BACKOFF_MS[Math.max(0, Math.min(j.attempts - 1, BACKOFF_MS.length - 1))];
  // AI_CHAT_V1: только 'working'. Задача в 'sending' (ответ, возможно, уже ушёл)
  // в очередь не возвращается никогда — иначе пациент получит ответ дважды.
  db.prepare(`UPDATE ai_chat_jobs SET status = 'queued', next_at = ? WHERE id = ? AND status = 'working'`).run(iso(now + wait), id);
  return 'retry';
}

/** Переключатель выключен — ждущие задачи снимаются; чаты остаются операторам. */
export function dropQueuedJobs(db, now = Date.now()) {
  return db.prepare(`UPDATE ai_chat_jobs SET status = 'dropped', finished_at = ? WHERE status = 'queued'`).run(iso(now)).changes;
}

export function recoverJobsAtBoot(db, now = Date.now()) {
  const requeued = db.prepare(`UPDATE ai_chat_jobs SET status = 'queued' WHERE status = 'working'`).run().changes;
  const failed = db.prepare(`SELECT channel, chat_key FROM ai_chat_jobs WHERE status = 'sending'`).all();
  db.prepare(`UPDATE ai_chat_jobs SET status = 'failed', outcome = 'unknown_send', finished_at = ? WHERE status = 'sending'`).run(iso(now));
  return { requeued, failed };
}

/**
 * AI_CHAT_V1: ждущая задача старше GIVE_UP_MS (сервер простоял, перезапуск) не
 * отвечается — поздний ответ хуже тишины. Возвращает чаты, которые надо
 * передать оператору (worker ставит им отметку 'timeout').
 */
export function expireStaleJobs(db, now = Date.now()) {
  return db.transaction(() => {
    const cutoff = iso(now - GIVE_UP_MS);
    const chats = db.prepare(`SELECT DISTINCT channel, chat_key FROM ai_chat_jobs WHERE status = 'queued' AND created_at < ?`).all(cutoff);
    db.prepare(`UPDATE ai_chat_jobs SET status = 'failed', outcome = 'timeout', finished_at = ? WHERE status = 'queued' AND created_at < ?`).run(iso(now), cutoff);
    return chats;
  })();
}
