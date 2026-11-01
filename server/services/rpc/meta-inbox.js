// META_INBOX_V1 — RPC «Чата Facebook и Instagram».
//
// Права — как у «Чата с пациентами» (rpc/telegram.js): раздел выдаётся ролям в
// «Настройки → Роли» ключом `meta-chat`; «Просмотр» — читать переписку и
// комментарии, «Изменение» — отвечать от имени клиники, скрывать комментарии,
// заводить карточку CRM. Администратор — всегда (ключа в его сеяных правах нет:
// раздел новее миграций ролей). Включить опрос — право настроек Meta
// (settings.meta: Изменение), как подключение самой Meta.
//
// Токен границу RPC не пересекает: экран получает только тексты, имена и
// слова причин.

import { isAdminUser, grantAllowsAdminOr } from '../grants.js';
import { canViewSection, canEditSection } from '../roles.js';
import { readSettingsRow } from '../meta/settings.js';
import {
  readInboxState, setInboxEnabled, listConversations, conversationById, conversationMessages, markConversationRead,
  listCommentThreads, commentThread, markThreadRead, unreadCounts,
} from '../meta/inbox-store.js';
import { pollInboxOnce, wakeInboxPolling } from '../meta/inbox-poller.js';
import {
  sendConversationMessage, replyToComment, privateReplyToComment, setCommentHidden, toCrm, windowOpen, REPLY_WINDOW_MS,
} from '../meta/inbox-actions.js';
import { inboxStats } from '../meta/inbox-stats.js';
import { metaInboxReasonText } from '../../../public/js/shared/meta-reasons.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export const CHAT_KEY = 'meta-chat';

function canView(db, user) { return isAdminUser(user) || canViewSection(db, user, CHAT_KEY); }
function canReply(db, user) { return isAdminUser(user) || canEditSection(db, user, CHAT_KEY); }
function canManage(db, user) { return grantAllowsAdminOr(db, user, 'settings.meta', 'edit'); }

function requireView(db, user) {
  if (!canView(db, user)) throw new RpcError('Раздел «Чат Facebook и Instagram» вам не выдан.', 403);
}
function requireReply(db, user) {
  requireView(db, user);
  if (!canReply(db, user)) throw new RpcError('У вас доступ «только чтение»: отвечать от имени клиники нельзя.', 403);
}

function rowId(args) {
  const n = Number(args && args.id);
  if (!Number.isInteger(n) || n <= 0) throw new RpcError('Не указана переписка или комментарий.', 400);
  return n;
}

/** Результат действия: удача — как есть; отказ — с фразой для экрана. */
function outcome(r) {
  return r.ok ? r : { ...r, message: metaInboxReasonText(r.reason) };
}

const PARTS = ['ig', 'messenger', 'instagram', 'facebook', 'instagram_comments'];

export function metaInboxState(db, _args, user) {
  requireView(db, user);
  const st = readInboxState(db) || { enabled: false, errors: {} };
  const s = readSettingsRow(db) || {};
  return {
    enabled: !!st.enabled,
    connected: !!(s.token_sealed && s.page_id),
    page_name: s.page_name || '',
    ig_username: st.ig_username || '',
    last_poll_at: st.last_poll_at || null,
    last_ok_at: st.last_ok_at || null,
    errors: PARTS.filter((p) => st.errors && st.errors[p]).map((p) => ({ part: p, reason: st.errors[p], text: metaInboxReasonText(st.errors[p]) })),
    can_reply: canReply(db, user),
    can_manage: canManage(db, user),
    unread: unreadCounts(db),
  };
}

export function metaInboxToggle(db, args, user) {
  requireView(db, user);
  if (!canManage(db, user)) throw new RpcError('Включать опрос может администратор или роль с правом «Meta: заявки из рекламы — Изменение».', 403);
  const on = !!(args && args.enabled);
  const s = readSettingsRow(db) || {};
  if (on && !(s.token_sealed && s.page_id)) throw new RpcError(metaInboxReasonText('no_page'), 409);
  setInboxEnabled(db, on, user && user.id ? user.id : null);
  if (on) wakeInboxPolling();
  return metaInboxState(db, {}, user);
}

export async function metaInboxPollNow(db, _args, user, deps = {}) {
  requireReply(db, user);
  await pollInboxOnce(db, deps);
  return metaInboxState(db, {}, user);
}

export function metaInboxConversations(db, _args, user) {
  requireView(db, user);
  const now = Date.now();
  return {
    conversations: listConversations(db).map((c) => ({ ...c, window_open: windowOpen(c, now) })),
    unread: unreadCounts(db),
  };
}

function userNames(db, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const rows = db.prepare(`SELECT id, full_name FROM users WHERE id IN (${uniq.map(() => '?').join(',')})`).all(...uniq);
  return new Map(rows.map((r) => [r.id, r.full_name || '']));
}

export function metaInboxMessages(db, args, user) {
  requireView(db, user);
  const conv = conversationById(db, rowId(args));
  if (!conv) throw new RpcError('Переписка не найдена.', 404);
  const messages = conversationMessages(db, conv.id);
  const names = userNames(db, messages.map((m) => m.sent_by));
  // Открыл — входящие прочитаны, как в «Чате с пациентами».
  markConversationRead(db, conv.id);
  const until = Date.parse(conv.last_in_at);
  return {
    conversation: {
      id: conv.id, platform: conv.platform, peer_name: conv.peer_name, peer_username: conv.peer_username,
      crm_request_id: conv.crm_request_id, window_open: windowOpen(conv),
      window_until: Number.isFinite(until) ? new Date(until + REPLY_WINDOW_MS).toISOString() : null,
    },
    messages: messages.map((m) => ({ ...m, error_text: m.error ? metaInboxReasonText(m.error) : '', sent_by_name: names.get(m.sent_by) || '' })),
  };
}

export async function metaInboxSend(db, args, user, deps = {}) {
  requireReply(db, user);
  return outcome(await sendConversationMessage(db, rowId(args), args && args.text, user && user.id, deps));
}

export function metaInboxComments(db, _args, user) {
  requireView(db, user);
  return { threads: listCommentThreads(db), unread: unreadCounts(db) };
}

export function metaInboxCommentThread(db, args, user) {
  requireView(db, user);
  const t = commentThread(db, rowId(args));
  if (!t) throw new RpcError('Комментарий не найден.', 404);
  markThreadRead(db, t.key);
  const names = userNames(db, t.comments.map((c) => c.sent_by));
  const r = t.root;
  return {
    post: { platform: r.platform, text: r.post_text, url: r.post_url, is_ad: !!r.post_is_ad },
    comments: t.comments.map((c) => ({
      id: c.id, author_name: c.author_name, text: c.text, created_at: c.created_at, is_page: !!c.is_page,
      is_hidden: !!c.is_hidden, is_root: c.comment_id === t.key, private_replied_at: c.private_replied_at,
      crm_request_id: c.crm_request_id, sent_by_name: names.get(c.sent_by) || '',
    })),
  };
}

export async function metaInboxCommentReply(db, args, user, deps = {}) {
  requireReply(db, user);
  return outcome(await replyToComment(db, rowId(args), args && args.text, user && user.id, deps));
}

export async function metaInboxCommentPrivate(db, args, user, deps = {}) {
  requireReply(db, user);
  return outcome(await privateReplyToComment(db, rowId(args), args && args.text, user && user.id, deps));
}

export async function metaInboxCommentHide(db, args, user, deps = {}) {
  requireReply(db, user);
  return outcome(await setCommentHidden(db, rowId(args), !!(args && args.hidden), deps));
}

export function metaInboxToCrm(db, args, user) {
  requireReply(db, user);
  const kind = args && args.kind === 'comment' ? 'comment' : 'conversation';
  const a = args || {};
  // META_INBOX_LEAD_FORM_V1 — имя, комментарий и «Ответственный — я» из формы.
  return outcome(toCrm(db, { kind, id: rowId(args), phone: a.phone || '', userId: user && user.id,
    name: a.name || '', comment: a.comment || '', takeIt: !!a.take }));
}

export function metaInboxUnread(db, _args, user) {
  requireView(db, user);
  return unreadCounts(db);
}

// META_INBOX_STATS_V1 — та же граница, что у чтения переписки: кто видит чат,
// видит и его цифры. Ничего не помечает прочитанным.
export function metaInboxStats(db, args, user) {
  requireView(db, user);
  return inboxStats(db, { days: args && args.days });
}
