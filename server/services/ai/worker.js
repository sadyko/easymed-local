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
import { readAiSettings, setAiBlocked, clearNoModuleBlock, hasAiModule } from './settings.js';
import { claimNextJob, markSending, finishJob, retryJob, dropQueuedJobs, expireStaleJobs, queuedTelegramChats } from './queue.js';
import { operatorRecent, isFlagged, flagChat } from './guards.js';
import { conversationFor } from './conversation.js';
import { clinicFacts } from './facts.js';
import { askControlPlane } from './cp-client.js';
import { createTelegramAiLead } from './lead.js';
import { sendChatMessage } from '../telegram/chat.js';
import { getDecryptedToken } from '../telegram/settings.js';
import { sendGotMessage } from '../telegram/flow.js';
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
  hasModule: (db) => hasAiModule(db),
  // Обычный ответ бота «сообщение принято» (kind 'system', не by_ai).
  ackTelegram: (db, token, chatId) => sendGotMessage(db, token, chatId),
};

const clip = (t) => String(t == null ? '' : t).trim();
const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
// AI_CHAT_V1: sendConversationMessage / replyToComment / privateReplyToComment
// отказывают тексту длиннее 2000 знаков — длинный ответ ИИ не должен стоить
// пациенту ответа. Обрезанная половина суррогатной пары и хвостовой пробел
// убираются: отправитель пишет текст обрезанным по краям, и по этому тексту
// мы потом ищем строку, чтобы пометить её «ИИ».
const META_MAX = 2000;
const metaClip = (t) => clip(t).slice(0, META_MAX).replace(/[\uD800-\uDBFF]$/, '').trim();

// AI_CHAT_V1 — правило владельца для комментариев: «под комментарием — что
// ответ дан в личке, сам ответ — в личке». Публично всегда эта короткая фраза
// (кроме reply_comment с непустым public_text): заявка или передача оператору
// могут нести телефон и подробности, им не место под постом.
export const COMMENT_PUBLIC_TEXT = 'Shaxsiy xabarlarda javob berdik. · Ответили вам в личных сообщениях.';

async function send(db, d, job, text) {
  if (job.channel === 'telegram') {
    const body = clip(text);
    if (!body) return { ok: false, reason: 'empty' };
    // Отметка by_ai для Telegram ставится внутри sendChatMessage ({ ai: true }).
    try { await d.sendTelegram(db, d.telegramToken(db), job.chat_key, body); return { ok: true }; }
    catch (e) { return { ok: false, reason: e.message }; }
  }
  if (job.channel === 'meta_dm') {
    const body = metaClip(text);
    if (!body) return { ok: false, reason: 'empty' };
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

/**
 * AI_CHAT_V1 — бот Telegram молчит о сообщении, которое взял ИИ (hooks.js).
 * Если задача кончилась без ответа ИИ (выключили, лимит, нет модуля, 10 минут
 * без ответа, сбой отправки), пациент услышал бы тишину — поэтому бот один раз
 * шлёт своё обычное «сообщение принято — оператор скоро ответит». По одному
 * разу на чат; никогда не бросает: подтверждение — вежливость, не работа.
 * Отвязанный или заблокировавший бота чат пропускается — туда не дойдёт.
 */
export async function ackTelegramChats(db, chatKeys, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const keys = [...new Set([].concat(chatKeys || []).map(String))];
  if (!keys.length) return 0;
  let token = '';
  try { token = d.telegramToken(db) || ''; } catch { token = ''; }
  if (!token) return 0;
  let sent = 0;
  for (const chatId of keys) {
    try {
      const ok = db.prepare('SELECT 1 FROM telegram_links WHERE chat_id = ? AND revoked_at IS NULL AND blocked_at IS NULL').get(chatId);
      if (!ok) continue;
      await d.ackTelegram(db, token, chatId);
      sent++;
    } catch (e) { console.warn('[ai] telegram ack:', e && e.message); }
  }
  return sent;
}

const telegramKeys = (rows) => rows.filter((r) => r.channel === 'telegram').map((r) => r.chat_key);

/** Публичный ответ и ответ в личку — на комментарий target (строка meta_comments). */
async function sendComment(db, d, target, publicText, privateText) {
  const pub = metaClip(publicText) || COMMENT_PUBLIC_TEXT;
  const priv = metaClip(privateText);
  // AI_CHAT_V1: сначала личный ответ — в нём суть. Публичное «ответили вам в
  // личных сообщениях» без личного ответа было бы неправдой (Meta отказывает в
  // личном ответе на старый комментарий или на уже отвеченный), поэтому личный
  // не ушёл — публично ничего, задача не удалась, нитка уходит оператору.
  const q = priv ? await d.privateReply(db, target.id, priv) : { ok: false };
  if (!(q && q.ok)) return { ok: false, reason: (q && q.reason) || 'private_failed' };
  const p = await d.replyComment(db, target.id, pub);
  if (p && p.ok) {
    // replyToComment кладёт ответ страницы в нитку с root_id = корень нитки.
    const rootKey = target.root_id || target.comment_id;
    db.prepare(`UPDATE meta_comments SET by_ai = 1 WHERE id = (
                  SELECT MAX(id) FROM meta_comments WHERE is_page = 1 AND sent_by IS NULL AND by_ai = 0
                    AND root_id = ? AND text = ?)`).run(rootKey, pub);
  }
  // Личный ответ дошёл — пациент ответ получил, даже если публичная фраза не легла.
  return { ok: true };
}

/**
 * Отправка по каналу. text — главный ответ (в чат или в личку под комментарием);
 * publicText — только для reply_comment, у остальных под комментарием
 * COMMENT_PUBLIC_TEXT.
 */
function sendAny(db, d, job, target, text, publicText = '') {
  return job.channel === 'meta_comment'
    ? sendComment(db, d, target, publicText, text)
    : send(db, d, job, text);
}

/**
 * Можно ли сейчас отвечать в этот чат. Проверяется дважды: до запроса к серверу
 * управления и ПОСЛЕ него — ответ ИИ идёт секунды, за это время сотрудник мог
 * написать в чат, а владелец — выключить ИИ. Возвращает null или причину.
 */
function stopReason(db, job, t) {
  const s = readAiSettings(db, t);
  if (!s.enabled || s.blocked) return 'switch_off';
  if (operatorRecent(db, job.channel, job.chat_key, t) || isFlagged(db, job.channel, job.chat_key)) return 'operator';
  if (job.channel === 'meta_dm') {
    const conv = conversationById(db, Number(job.chat_key));
    if (!conv || !windowOpen(conv, t)) return 'window_closed';
  }
  return null;
}

const STOP_RESULT = { switch_off: 'dropped', operator: 'skipped', window_closed: 'handed_off' };

async function applyStop(db, d, job, reason, t) {
  if (reason === 'switch_off') {
    finishJob(db, job.id, 'dropped', 'switch_off', t);
    // AI_CHAT_V1: ИИ выключили или остановили, пока сообщение ждало, — бот за
    // него не ответил; подтверждаем как бот (и всем снятым из очереди тоже).
    const chats = job.channel === 'telegram' ? [job.chat_key] : [];
    chats.push(...queuedTelegramChats(db));
    dropQueuedJobs(db, t);
    await ackTelegramChats(db, chats, d);
  }
  // Оператор написал в чат — пациенту ответил человек, подтверждать нечего.
  else if (reason === 'operator') finishJob(db, job.id, 'dropped', 'operator', t);
  else { flagChat(db, job.channel, job.chat_key, 'window_closed', t); finishJob(db, job.id, 'handed_off', 'window_closed', t); }
  return STOP_RESULT[reason];
}

/**
 * AI_CHAT_V1: Telegram, в который ответ заведомо не дойдёт (нет токена бота,
 * чат отвязан, пациент заблокировал бота), — не повод для платного запроса к
 * серверу управления. Отметку не ставим: оператору там тоже писать некуда.
 */
function telegramReachable(db, d, job) {
  let token = '';
  try { token = d.telegramToken(db) || ''; } catch { token = ''; }
  if (!token) return false;
  return !!db.prepare('SELECT 1 FROM telegram_links WHERE chat_id = ? AND revoked_at IS NULL AND blocked_at IS NULL').get(String(job.chat_key));
}

/** Одна задача. Возвращает: 'idle' | 'done' | 'handed_off' | 'skipped' | 'dropped' | 'blocked' | 'retry' | 'failed'. */
export async function processOneJob(db, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const now = d.now();
  // AI_CHAT_V1: модуль `ai` снова в лицензии — «нет модуля» снимается сам, без
  // захода владельца на экран. Сбой проверки лицензии исполнитель не роняет.
  try { clearNoModuleBlock(db, d.hasModule); } catch (e) { console.warn('[ai] licence check:', e && e.message); }
  // AI_CHAT_V1 (A3): ждущая задача старше 10 минут (сервер стоял, перезапуск)
  // не отвечается — поздний ответ хуже тишины; её чат уходит оператору.
  const stale = expireStaleJobs(db, now);
  for (const c of stale) flagChat(db, c.channel, c.chat_key, 'timeout', now);
  // Бот за этих пациентов промолчал — подтверждаем «сообщение принято».
  await ackTelegramChats(db, telegramKeys(stale), d);

  const job = claimNextJob(db, now);
  if (!job) return 'idle';
  let t = now;
  const handOff = (reason) => flagChat(db, job.channel, job.chat_key, reason || 'hand_off', t);
  // Ответ ИИ пациенту в Telegram не ушёл — бот подтверждает сам (один раз).
  const ackThis = () => (job.channel === 'telegram' ? ackTelegramChats(db, [job.chat_key], d) : Promise.resolve(0));

  // Всё после взятия задачи — под try: упавшее чтение базы не должно оставить
  // задачу в 'working' и не должно оборвать цикл исполнителя. До markSending
  // закрывать задачу безопасно — пациенту ничего не ушло.
  try {
    let target = null;
    if (job.channel === 'meta_comment') {
      target = db.prepare('SELECT id, comment_id, root_id, private_replied_at FROM meta_comments WHERE comment_id = ?').get(String(job.source_id)) || null;
    }
    const s = readAiSettings(db, t);
    if (!s.enabled || s.blocked) return await applyStop(db, d, job, 'switch_off', t);
    if (job.channel === 'meta_comment') {
      if (!target) { finishJob(db, job.id, 'dropped', 'gone', t); return 'dropped'; }
      // Meta разрешает один личный ответ на комментарий; уже ответили (сотрудник
      // или ИИ) — второй раз ИИ на этот комментарий не отвечает.
      if (target.private_replied_at) { finishJob(db, job.id, 'dropped', 'already_replied', t); return 'dropped'; }
    }
    const before = stopReason(db, job, t);
    if (before) return await applyStop(db, d, job, before, t);
    if (job.channel === 'telegram' && !telegramReachable(db, d, job)) {
      finishJob(db, job.id, 'dropped', 'unreachable', t); return 'dropped';
    }

    const conv = conversationFor(db, job.channel, job.chat_key);
    const answer = (await d.ask({
      channel: job.channel, transcript: conv.transcript, patient_name: conv.patientName, post_text: conv.postText, facts: d.facts(db),
    })) || { error: 'bad_response' };
    // Ответ шёл секунды: дальше — время ответа, а не взятия задачи.
    t = d.now();

    if (answer.error === 'limit' || answer.error === 'no_module') {
      setAiBlocked(db, answer.error, isoOf(t));
      handOff(answer.error);
      finishJob(db, job.id, 'failed', answer.error, t);
      const chats = job.channel === 'telegram' ? [job.chat_key] : [];
      chats.push(...queuedTelegramChats(db));
      dropQueuedJobs(db, t);
      await ackTelegramChats(db, chats, d);
      return 'blocked';
    }
    if (answer.error === 'network' || answer.error === 'not_enrolled') {
      if (retryJob(db, job.id, t) === 'gave_up') { handOff('timeout'); await ackThis(); return 'failed'; }
      return 'retry';
    }

    // Повторная проверка ПОСЛЕ запроса: сотрудник написал, ИИ выключили, окно
    // Meta закрылось, пока ИИ думал, — ответ не отправляется.
    const after = stopReason(db, job, t);
    if (after) return await applyStop(db, d, job, after, t);

    markSending(db, job.id);
    // Ошибка, отличная от выше (bad_response, too_large), — то же, что hand_off:
    // повтор дал бы тот же ответ, пациент ждёт человека.
    if (answer.error || answer.outcome === 'hand_off') {
      const text = (answer.outcome === 'hand_off' && clip(answer.text)) || HANDOFF_TEXT;
      const r = await sendAny(db, d, job, target, text);
      handOff(answer.error || answer.reason || 'hand_off');
      if (!(r && r.ok)) await ackThis();
      finishJob(db, job.id, 'handed_off', 'hand_off', t);
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
          // Номер, который не номер, не должен стоить пациенту заявки; сырой
          // номер остаётся в комментарии — администратор разберёт его сам.
          if (lead && lead.ok === false && lead.reason === 'bad_phone') {
            lead = d.metaLead(db, { ...args, phone: '', comment: args.comment + '\nТелефон (не распознан): ' + phone });
          }
        }
      } catch (e) { lead = { ok: false, reason: e.message }; }
      if (!lead || lead.ok === false) {
        // «Администратор свяжется с вами» без заявки — обещание, которое никто
        // не выполнит. Вместо него — передача человеку.
        const r = await sendAny(db, d, job, target, HANDOFF_TEXT);
        handOff('lead_failed');
        if (!(r && r.ok)) await ackThis();
        finishJob(db, job.id, 'handed_off', 'lead_failed', t);
        return 'handed_off';
      }
    }

    const sent = answer.outcome === 'reply_comment'
      ? await sendAny(db, d, job, target, answer.private_text || answer.text, answer.public_text)
      : await sendAny(db, d, job, target, answer.text);
    if (!sent.ok) { handOff('send_failed'); finishJob(db, job.id, 'failed', 'send_failed', t); await ackThis(); return 'failed'; }
    finishJob(db, job.id, 'done', answer.outcome, t);
    return 'done';
  } catch (e) {
    // Неожиданная ошибка: задача не должна висеть в 'working'/'sending' и не
    // должна повторяться (после markSending ответ мог уйти) — закрываем, чат — оператору.
    console.warn('[ai] job', job.id, e && e.message);
    try { handOff('error'); finishJob(db, job.id, 'failed', 'error', t); } catch { /* база недоступна — разберёт recoverJobsAtBoot */ }
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
