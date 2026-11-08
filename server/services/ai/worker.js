// AI_CHAT_V1 — исполнитель: одна задача от начала до конца.
//
// Перед запросом заново проверяет всё, что могло измениться с постановки:
// переключатель, недавний оператор, отметка «Нужен оператор», окно Meta 24 ч.
// Ответ сервера управления — ровно один из четырёх исходов; всё остальное
// (отказ, мусор, слишком большой запрос) — передача оператору. Отправка —
// только существующими функциями, заявки — только createTelegramAiLead / toCrm.
// Состояние 'sending' пишется ДО отправки (и до заявки): после перезапуска
// такую задачу не повторяют (queue.js recoverJobsAtBoot).
//
// Комментарии Facebook/Instagram — НИТКА: chat_key — id строки корня нитки
// (отметки, слияние, проверка оператора — по нитке), а отвечаем на тот
// комментарий, что пришёл: source_id — его comment_id у Meta.
import { readAiSettings, setAiBlocked } from './settings.js';
import { claimNextJob, markSending, finishJob, retryJob, dropQueuedJobs, expireStaleJobs } from './queue.js';
import { operatorRecent, isFlagged, flagChat } from './guards.js';
import { conversationFor } from './conversation.js';
import { clinicFacts } from './facts.js';
import { askControlPlane } from './cp-client.js';
import { createTelegramAiLead } from './lead.js';
import { sendChatMessage } from '../telegram/chat.js';
import { getDecryptedToken } from '../telegram/settings.js';
import { sendConversationMessage, replyToComment, privateReplyToComment, toCrm, windowOpen } from '../meta/inbox-actions.js';
import { conversationById } from '../meta/inbox-store.js';

export const HANDOFF_TEXT = 'Hozir klinika xodimini ulayman. · Сейчас подключу сотрудника клиники.';
// { ai: true } — sendChatMessage пишет by_ai = 1 и не ставит подпись сотрудника;
// id: null — у ответа ИИ нет sent_by, guards.js не примет его за оператора.
const AI_USER = Object.freeze({ id: null, full_name: '', ai: true });

const DEFAULT_DEPS = {
  now: () => Date.now(),
  telegramToken: (db) => getDecryptedToken(db),
  ask: (payload) => askControlPlane(payload),
  sendTelegram: (db, token, chatId, text) => sendChatMessage(db, token, chatId, text, AI_USER),
  telegramLead: (db, args) => createTelegramAiLead(db, args),
  sendMetaDm: (db, convId, text) => sendConversationMessage(db, Number(convId), text, null),
  replyComment: (db, id, text) => replyToComment(db, Number(id), text, null),
  privateReply: (db, id, text) => privateReplyToComment(db, Number(id), text, null),
  metaLead: (db, args) => toCrm(db, args),
  facts: (db) => clinicFacts(db),
};

const clip = (t) => String(t == null ? '' : t).trim();

async function send(db, d, job, text) {
  const body = clip(text);
  if (!body) return { ok: false, reason: 'empty' };
  if (job.channel === 'telegram') {
    // Отметка by_ai для Telegram ставится внутри sendChatMessage ({ ai: true }).
    try { await d.sendTelegram(db, d.telegramToken(db), job.chat_key, body); return { ok: true }; }
    catch (e) { return { ok: false, reason: e.message }; }
  }
  if (job.channel === 'meta_dm') {
    const r = await d.sendMetaDm(db, job.chat_key, body);
    // Помечаем именно только что записанную строку: исходящая без sent_by с тем
    // же текстом. «Последняя исходящая» могла бы оказаться ответом сотрудника,
    // набранным в приложении Meta и принесённым опросом в ту же секунду.
    if (r && r.ok) {
      db.prepare(`UPDATE meta_messages SET by_ai = 1 WHERE id = (
                    SELECT MAX(id) FROM meta_messages WHERE conversation_id = ? AND direction = 'out'
                      AND sent_by IS NULL AND by_ai = 0 AND status = 'ok' AND text = ?)`).run(Number(job.chat_key), body);
    }
    return r || { ok: false };
  }
  return { ok: false, reason: 'channel' };
}

/** Публичный ответ и ответ в личку — на комментарий target (строка meta_comments). */
async function sendComment(db, d, target, publicText, privateText) {
  const pub = clip(publicText);
  const priv = clip(privateText);
  const p = pub ? await d.replyComment(db, target.id, pub) : { ok: false };
  if (p && p.ok) {
    // replyToComment кладёт ответ страницы в нитку с root_id = корень нитки.
    const rootKey = target.root_id || target.comment_id;
    db.prepare(`UPDATE meta_comments SET by_ai = 1 WHERE id = (
                  SELECT MAX(id) FROM meta_comments WHERE is_page = 1 AND sent_by IS NULL AND by_ai = 0
                    AND root_id = ? AND text = ?)`).run(rootKey, pub);
  }
  const q = priv ? await d.privateReply(db, target.id, priv) : { ok: false };
  return { ok: !!(p && p.ok) || !!(q && q.ok) };
}

function sendAny(db, d, job, target, publicText, privateText) {
  return job.channel === 'meta_comment'
    ? sendComment(db, d, target, publicText, privateText)
    : send(db, d, job, privateText);
}

/** Одна задача. Возвращает: 'idle' | 'done' | 'handed_off' | 'skipped' | 'dropped' | 'blocked' | 'retry' | 'failed'. */
export async function processOneJob(db, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const now = d.now();
  // AI_CHAT_V1 (A3): ждущая задача старше 10 минут (сервер стоял, перезапуск)
  // не отвечается — поздний ответ хуже тишины; её чат уходит оператору.
  for (const c of expireStaleJobs(db, now)) flagChat(db, c.channel, c.chat_key, 'timeout', now);

  const job = claimNextJob(db, now);
  if (!job) return 'idle';
  const handOff = (reason) => flagChat(db, job.channel, job.chat_key, reason || 'hand_off', now);

  const s = readAiSettings(db);
  if (!s.enabled || s.blocked) { finishJob(db, job.id, 'dropped', 'switch_off', now); dropQueuedJobs(db, now); return 'dropped'; }

  let target = null;
  if (job.channel === 'meta_comment') {
    target = db.prepare('SELECT id, comment_id, root_id, private_replied_at FROM meta_comments WHERE comment_id = ?').get(String(job.source_id)) || null;
    if (!target) { finishJob(db, job.id, 'dropped', 'gone', now); return 'dropped'; }
    // Meta разрешает один личный ответ на комментарий; уже ответили (сотрудник
    // или ИИ) — второй раз ИИ на этот комментарий не отвечает.
    if (target.private_replied_at) { finishJob(db, job.id, 'dropped', 'already_replied', now); return 'dropped'; }
  }
  if (operatorRecent(db, job.channel, job.chat_key, now) || isFlagged(db, job.channel, job.chat_key)) {
    finishJob(db, job.id, 'dropped', 'operator', now); return 'skipped';
  }
  if (job.channel === 'meta_dm') {
    const conv = conversationById(db, Number(job.chat_key));
    if (!conv || !windowOpen(conv, now)) { handOff('window_closed'); finishJob(db, job.id, 'handed_off', 'window_closed', now); return 'handed_off'; }
  }

  try {
    const conv = conversationFor(db, job.channel, job.chat_key);
    const answer = (await d.ask({
      channel: job.channel, transcript: conv.transcript, patient_name: conv.patientName, post_text: conv.postText, facts: d.facts(db),
    })) || { error: 'bad_response' };

    if (answer.error === 'limit' || answer.error === 'no_module') {
      setAiBlocked(db, answer.error, new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'));
      handOff(answer.error);
      finishJob(db, job.id, 'failed', answer.error, now);
      dropQueuedJobs(db, now);
      return 'blocked';
    }
    if (answer.error === 'network' || answer.error === 'not_enrolled') {
      if (retryJob(db, job.id, now) === 'gave_up') { handOff('timeout'); return 'failed'; }
      return 'retry';
    }

    markSending(db, job.id);
    // Ошибка, отличная от выше (bad_response, too_large), — то же, что hand_off:
    // повтор дал бы тот же ответ, пациент ждёт человека.
    if (answer.error || answer.outcome === 'hand_off') {
      const text = (answer.outcome === 'hand_off' && clip(answer.text)) || HANDOFF_TEXT;
      await sendAny(db, d, job, target, text, text);
      handOff(answer.error || answer.reason || 'hand_off');
      finishJob(db, job.id, 'handed_off', 'hand_off', now);
      return 'handed_off';
    }

    if (answer.outcome === 'create_lead') {
      const phone = clip(answer.phone) || conv.linkPhone;
      let lead;
      try {
        if (job.channel === 'telegram') {
          lead = d.telegramLead(db, { chatId: job.chat_key, phone, name: clip(answer.name) || conv.patientName, wish: answer.wish });
        } else {
          const args = {
            kind: job.channel === 'meta_dm' ? 'conversation' : 'comment',
            id: job.channel === 'meta_dm' ? Number(job.chat_key) : target.id,
            phone, name: clip(answer.name), comment: 'Создано ИИ: ' + clip(answer.wish),
          };
          lead = d.metaLead(db, args);
          // Номер, который не номер, не должен стоить пациенту заявки.
          if (lead && lead.ok === false && lead.reason === 'bad_phone') lead = d.metaLead(db, { ...args, phone: '' });
        }
      } catch (e) { lead = { ok: false, reason: e.message }; }
      if (!lead || lead.ok === false) {
        // «Администратор свяжется с вами» без заявки — обещание, которое никто
        // не выполнит. Вместо него — передача человеку.
        await sendAny(db, d, job, target, HANDOFF_TEXT, HANDOFF_TEXT);
        handOff('lead_failed');
        finishJob(db, job.id, 'handed_off', 'lead_failed', now);
        return 'handed_off';
      }
    }

    const sent = await sendAny(db, d, job, target,
      answer.public_text || answer.text, answer.private_text || answer.text);
    if (!sent.ok) { handOff('send_failed'); finishJob(db, job.id, 'failed', 'send_failed', now); return 'failed'; }
    finishJob(db, job.id, 'done', answer.outcome, now);
    return 'done';
  } catch (e) {
    // Неожиданная ошибка не должна оставить задачу висеть в 'working'/'sending'
    // и не должна повторяться (ответ мог уйти): закрываем, чат — оператору.
    console.warn('[ai] job', job.id, e && e.message);
    handOff('error');
    finishJob(db, job.id, 'failed', 'error', now);
    return 'failed';
  }
}

let timer = null;
let running = false;
/** Исполнитель в фоне: шаг каждые 5 секунд, за шаг — все готовые задачи по одной. */
export function startAiWorker(db, { intervalMs = 5000, deps = {} } = {}) {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      // 'retry' оставляет задачу в очереди с паузой — claimNextJob её не возьмёт
      // до next_at, поэтому цикл кончается на 'idle'.
      while ((await processOneJob(db, deps)) !== 'idle') { /* следующая */ }
    } catch (e) { console.warn('[ai] worker:', e && e.message); }
    finally { running = false; }
  }, intervalMs);
  if (timer.unref) timer.unref();
}
export function stopAiWorker() { if (timer) clearInterval(timer); timer = null; }
