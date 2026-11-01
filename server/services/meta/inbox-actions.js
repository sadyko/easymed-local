// META_INBOX_V1 — что клиника делает из «Чата Facebook и Instagram»: ответ в
// переписке, публичный ответ на комментарий, ответ в личку на комментарий,
// скрыть / показать комментарий, карточка в CRM.
//
// Отказ Meta — { ok: false, reason } со словом причины, НЕ исключение: экран
// показывает фразу (shared/meta-reasons.js), а неотправленный ответ остаётся в
// ленте строкой «не доставлено» — сотрудник видит, что пациент его не получил.
//
// Правила Meta, которые проверяем сами, до запроса:
//   * переписка — ответить можно в течение 24 часов после последнего сообщения
//     человека (стандартное окно Messenger и Instagram). Позже Meta отказывает
//     кодом 10 / 2018278; мы говорим это раньше и понятнее;
//   * ответ в личку на комментарий — один на комментарий (и в течение 7 дней,
//     это скажет уже Meta).

import { graphPost } from './graph.js';
import { readSettingsRow, getTokens } from './settings.js';
import {
  readInboxState, conversationById, insertMessage, refreshConversationSummary, commentById, commentThread,
  upsertComment, nowIso,
} from './inbox-store.js';
import { uzE164 } from '../../../public/js/admin/views/crm-phone-match.js';
import { contactDecision, firstStageKey, reopenLead } from '../crm/contact-window.js';
import { leadsForPhone } from '../crm/lead-from-call.js';
import { patientIdForPhone } from '../crm/patient-by-phone.js';
import { ensureMetaSource, appendToCard, META_SOURCE_KEY } from './leads.js';

export const REPLY_WINDOW_MS = 24 * 3600 * 1000;
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

/** Код ошибки Meta при записи → слово причины (поверх общего словаря graph.js). */
export function sendReason(r) {
  if (r.code === 10 && (r.subcode === 2018278 || /outside of allowed window/i.test(r.message || ''))) return 'window_closed';
  if (r.code === 551 || r.subcode === 1545041) return 'user_unavailable';
  return r.reason || 'server_error';
}

/** Токен страницы и id страницы; нет подключения — слово причины. */
function connection(db, deps) {
  const row = readSettingsRow(db) || {};
  if (!row.token_sealed || !row.page_id) return { reason: 'no_page' };
  let t;
  try { t = getTokens(db, { kekPath: deps.kekPath }); } catch { return { reason: 'kek' }; }
  const token = t.pageToken || t.token;
  if (!token) return { reason: 'no_token' };
  return { token, pageId: String(row.page_id), pageName: String(row.page_name || '') };
}

/** Открыто ли окно ответа в переписке (24 часа после последнего входящего). */
export function windowOpen(conv, now = Date.now()) {
  const t = Date.parse(conv && conv.last_in_at);
  return Number.isFinite(t) && now - t < REPLY_WINDOW_MS;
}

const clip = (text) => String(text == null ? '' : text).trim();

/** Ответ в переписке Messenger / Instagram. */
export async function sendConversationMessage(db, convId, text, userId, deps = {}) {
  const conv = conversationById(db, convId);
  if (!conv) return { ok: false, reason: 'not_found' };
  const body = clip(text);
  if (!body) return { ok: false, reason: 'empty' };
  if (body.length > 2000) return { ok: false, reason: 'too_long' };
  if (!conv.peer_id) return { ok: false, reason: 'not_found' };
  if (!windowOpen(conv, deps.now || Date.now())) return { ok: false, reason: 'window_closed' };
  const c = connection(db, deps);
  if (c.reason) return { ok: false, reason: c.reason };
  const r = await graphPost(`${c.pageId}/messages`, {
    recipient: { id: conv.peer_id }, messaging_type: 'RESPONSE', message: { text: body },
  }, { token: c.token, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
  if (!r.ok) {
    const reason = sendReason(r);
    db.prepare(`INSERT INTO meta_messages (conversation_id, direction, text, created_at, read_at, status, error, sent_by)
                VALUES (?, 'out', ?, ${NOW_SQL}, ${NOW_SQL}, 'failed', ?, ?)`).run(conv.id, body, reason, userId || null);
    return { ok: false, reason };
  }
  const msgId = r.data && (r.data.message_id || r.data.id);
  insertMessage(db, conv.id, { msg_id: msgId ? String(msgId) : null, direction: 'out', text: body, created_at: nowIso(), sent_by: userId || null });
  refreshConversationSummary(db, conv.id);
  return { ok: true };
}

/**
 * Публичный ответ на комментарий. И Facebook, и Instagram держат две ступени
 * (комментарий и ответы под ним), поэтому отвечаем всегда в корень нитки.
 */
export async function replyToComment(db, commentRowId, text, userId, deps = {}) {
  const thread = commentThread(db, commentRowId);
  if (!thread) return { ok: false, reason: 'not_found' };
  const body = clip(text);
  if (!body) return { ok: false, reason: 'empty' };
  if (body.length > 2000) return { ok: false, reason: 'too_long' };
  const c = connection(db, deps);
  if (c.reason) return { ok: false, reason: c.reason };
  const root = thread.root;
  const edge = root.platform === 'instagram' ? 'replies' : 'comments';
  const r = await graphPost(`${thread.key}/${edge}`, { message: body }, { token: c.token, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
  if (!r.ok) return { ok: false, reason: sendReason(r) };
  const st = readInboxState(db) || {};
  upsertComment(db, {
    platform: root.platform, comment_id: String((r.data && r.data.id) || `local_${Date.now()}`), parent_id: thread.key,
    post_id: root.post_id, post_text: root.post_text, post_url: root.post_url, post_is_ad: !!root.post_is_ad,
    author_name: root.platform === 'instagram' ? (st.ig_username || c.pageName) : c.pageName,
    text: body, created_at: nowIso(), is_page: true, sent_by: userId || null,
  });
  return { ok: true };
}

/** Ответ в личку на комментарий: Meta открывает переписку с автором. Один на комментарий. */
export async function privateReplyToComment(db, commentRowId, text, userId, deps = {}) {
  const cm = commentById(db, commentRowId);
  if (!cm) return { ok: false, reason: 'not_found' };
  if (cm.is_page) return { ok: false, reason: 'own_comment' };
  if (cm.private_replied_at) return { ok: false, reason: 'already_replied' };
  const body = clip(text);
  if (!body) return { ok: false, reason: 'empty' };
  if (body.length > 2000) return { ok: false, reason: 'too_long' };
  const c = connection(db, deps);
  if (c.reason) return { ok: false, reason: c.reason };
  const r = await graphPost(`${c.pageId}/messages`, {
    recipient: { comment_id: cm.comment_id }, message: { text: body },
  }, { token: c.token, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
  if (!r.ok) return { ok: false, reason: sendReason(r) };
  db.prepare(`UPDATE meta_comments SET private_replied_at = ${NOW_SQL}, sent_by = COALESCE(sent_by, ?) WHERE id = ?`).run(userId || null, cm.id);
  return { ok: true };
}

/** Скрыть / показать комментарий (виден автору и его друзьям, остальным — нет). */
export async function setCommentHidden(db, commentRowId, hidden, deps = {}) {
  const cm = commentById(db, commentRowId);
  if (!cm) return { ok: false, reason: 'not_found' };
  if (cm.is_page) return { ok: false, reason: 'own_comment' };
  const c = connection(db, deps);
  if (c.reason) return { ok: false, reason: c.reason };
  const field = cm.platform === 'instagram' ? 'hide' : 'is_hidden';
  const r = await graphPost(cm.comment_id, { [field]: hidden ? 'true' : 'false' }, { token: c.token, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
  if (!r.ok) return { ok: false, reason: sendReason(r) };
  db.prepare('UPDATE meta_comments SET is_hidden = ? WHERE id = ?').run(hidden ? 1 : 0, cm.id);
  return { ok: true };
}

const PLATFORM_LABEL = { messenger: 'Messenger', instagram: 'Instagram Direct', facebook: 'Facebook', comments_instagram: 'Instagram' };

/**
 * Карточка CRM из переписки или комментария. Телефон — если сотрудник его
 * узнал (в Messenger его обычно нет): тогда правило повторного обращения CRM,
 * как у заявки из формы (leads.js fileLead) — открытая карточка с этим номером
 * получает запись, а не вторую карточку. Повторное «В CRM» той же переписки
 * возвращает уже созданную карточку.
 *
 * META_INBOX_LEAD_FORM_V1 — владелец (2026-10-31), со снимком «Комментариев в
 * Instagram»: «make possible to generate lead to crm from chats or comments».
 * Раньше кнопка спрашивала только телефон окошком браузера; теперь у неё
 * форма: имя (по умолчанию — имя в Meta, у Instagram это никнейм), телефон,
 * комментарий сотрудника и «Ответственный — я». Комментарий дописывается к
 * записи из переписки; ответственный ставится только новой карточке —
 * открытую карточку с тем же номером ведёт тот, кто её уже ведёт.
 */
export function toCrm(db, { kind, id, phone = '', userId = null, name: nameIn = '', comment = '', takeIt = false }) {
  const isConv = kind === 'conversation';
  const row = isConv ? conversationById(db, id) : commentById(db, id);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.crm_request_id && db.prepare('SELECT 1 FROM crm_requests WHERE id = ?').get(row.crm_request_id)) {
    return { ok: true, status: 'exists', crm_request_id: row.crm_request_id };
  }
  const phoneNorm = clip(phone) ? (uzE164(clip(phone)) || '') : '';
  // Иностранный номер uzE164 пропускает как есть; короче 9 цифр — не номер.
  if (clip(phone) && phoneNorm.replace(/\D/g, '').length < 9) return { ok: false, reason: 'bad_phone' };

  let name, note;
  if (isConv) {
    name = row.peer_name || (row.peer_username ? '@' + row.peer_username : '') || 'Сообщение Meta';
    const lastIn = db.prepare(`SELECT text FROM meta_messages WHERE conversation_id = ? AND direction = 'in' AND text <> ''
                                ORDER BY created_at DESC, id DESC LIMIT 5`).all(row.id).map((m) => m.text).reverse();
    note = [`Сообщение в ${PLATFORM_LABEL[row.platform] || 'Meta'}` + (row.peer_username ? ` · @${row.peer_username}` : ''), ...lastIn].join('\n');
  } else {
    name = row.author_name || 'Комментарий Meta';
    const where = row.platform === 'instagram' ? 'Instagram' : (row.post_is_ad ? 'рекламе Facebook' : 'Facebook');
    note = [`Комментарий в ${where}` + (row.post_text ? ` под «${row.post_text.slice(0, 80)}»` : ''), row.text, row.post_url].filter(Boolean).join('\n');
  }
  if (clip(nameIn)) name = clip(nameIn);
  if (clip(comment)) note += '\n\nКомментарий сотрудника: ' + clip(comment).slice(0, 2000);
  const owner = takeIt && userId ? db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(Number(userId)) : null;

  return db.transaction(() => {
    ensureMetaSource(db);
    let decision = { action: 'new', lead: null };
    if (phoneNorm) decision = contactDecision(db, leadsForPhone(db, phoneNorm));
    let crmId, status;
    if ((decision.action === 'same' || decision.action === 'reopen') && decision.lead) {
      if (decision.action === 'reopen') reopenLead(db, decision.lead.id);
      appendToCard(db, decision.lead.id, note);
      crmId = decision.lead.id; status = 'merged';
    } else {
      crmId = Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, source, sources, status, note, patient_id, assigned_to, created_by)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(name.slice(0, 200), phoneNorm, META_SOURCE_KEY, JSON.stringify([META_SOURCE_KEY]),
          firstStageKey(db) || 'in_process', note, phoneNorm ? patientIdForPhone(db, phoneNorm) : null,
          owner ? owner.id : null, Number(userId) || null).lastInsertRowid);
      status = 'created';
    }
    // META_INBOX_STATS_V1 — момент, сотрудник и исход: статистика считает лиды
    // за период по этой дате, а не по дате карточки (у дописанной она давняя).
    db.prepare(`UPDATE ${isConv ? 'meta_conversations' : 'meta_comments'}
                   SET crm_request_id = ?, crm_linked_at = ${NOW_SQL}, crm_linked_by = ?, crm_link_kind = ? WHERE id = ?`)
      .run(crmId, userId || null, status, row.id);
    return { ok: true, status, crm_request_id: crmId };
  })();
}
