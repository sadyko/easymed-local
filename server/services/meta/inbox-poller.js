// META_INBOX_V1 — опрос переписки и комментариев страницы клиники.
//
// Клиника локальная: у неё нет адреса в интернете, и вебхук Meta до неё не
// дойдёт. Поэтому, как опрос заявок (poller.js), сервер сам спрашивает Graph
// API раз в минуту. Форма та же: проход никогда не бросает, проходы не
// накладываются, лицензионный модуль (`crm`, как у заявок) проверяется каждый
// проход, недействительный токен выключает опрос.
//
// Один проход — пять независимых частей; отказ одной не мешает остальным, и у
// каждой своё слово причины в meta_inbox_state.errors_json (экран говорит, ЧТО
// не работает: например, Messenger работает, а у Instagram нет права):
//   ig        — какой Instagram привязан к странице (/{page}?fields=instagram_business_account);
//   messenger — /{page}/conversations?platform=messenger, по 25 сообщений;
//   instagram — то же с platform=instagram (только если Instagram привязан);
//   facebook  — комментарии под постами (/{page}/feed) и рекламой (/{page}/ads_posts);
//   instagram_comments — комментарии под публикациями (/{ig}/media).
//
// Переписка, у которой updated_time не изменился, не перечитывается. Всё
// пишется по id Meta, поэтому повтор окна бесплатен.
//
// Читается токеном СТРАНИЦЫ (как заявки): права pages_messaging,
// instagram_manage_messages, pages_read_user_content, instagram_manage_comments
// действуют на страницу.

import { controlState } from '../control/state.js';
import { getDataDir } from '../control/config.js';
import { graphGet, graphGetAll } from './graph.js';
import { readSettingsRow, getTokens } from './settings.js';
import {
  readInboxState, recordInboxPoll, conversationByConvId, upsertConversation, insertMessage,
  refreshConversationSummary, upsertComment, isoZ,
} from './inbox-store.js';

const INITIAL_DELAY_MS = 25_000;
export const INBOX_PERIOD_MS = 60_000;

const MESSAGE_FIELDS = 'id,created_time,from,message,attachments,sticker';
export const CONV_FIELDS = `id,updated_time,participants,messages.limit(25){${MESSAGE_FIELDS}}`;
const FB_COMMENT_FIELDS = 'id,message,from,created_time,parent{id},is_hidden';
export const FB_POST_FIELDS = `id,message,permalink_url,created_time,comments.filter(stream).order(reverse_chronological).limit(50){${FB_COMMENT_FIELDS}}`;
const IG_COMMENT_FIELDS = 'id,text,username,timestamp,from,hidden';
export const IG_MEDIA_FIELDS = `id,caption,permalink,timestamp,comments.limit(50){${IG_COMMENT_FIELDS},replies.limit(50){${IG_COMMENT_FIELDS}}}`;

function defaultHasModule(db) {
  try { return controlState(db, getDataDir()).has('crm'); } catch { return false; }
}

const str = (v) => (v == null ? '' : String(v)).trim();
const list = (v) => (v && Array.isArray(v.data) ? v.data : []);

/** Вложение сообщения → { type, url, name } (то, что можно показать или открыть). */
export function parseAttachments(raw) {
  const out = [];
  for (const a of list(raw && raw.attachments)) {
    if (!a || typeof a !== 'object') continue;
    const img = a.image_data && (a.image_data.url || a.image_data.preview_url);
    const vid = a.video_data && (a.video_data.url || a.video_data.preview_url);
    if (img) out.push({ type: 'image', url: String(img), name: str(a.name) });
    else if (vid) out.push({ type: 'video', url: String(vid), name: str(a.name) });
    else if (a.file_url) out.push({ type: 'file', url: String(a.file_url), name: str(a.name) || 'файл' });
    else out.push({ type: 'other', url: '', name: str(a.name || a.mime_type) });
  }
  if (raw && raw.sticker) out.push({ type: 'image', url: String(raw.sticker), name: 'sticker' });
  return out;
}

/** Собеседник переписки — участник, который не страница и не её Instagram. */
export function peerOf(conv, ownIds) {
  const p = list(conv && conv.participants).find((x) => x && !ownIds.has(str(x.id)));
  return p ? { id: str(p.id), name: str(p.name), username: str(p.username) } : { id: '', name: '', username: '' };
}

async function pollConversations(db, platform, ctx) {
  const { pageId, ownIds, token, readBefore, fetchImpl, timeoutMs } = ctx;
  const r = await graphGetAll(`${pageId}/conversations`, { platform, fields: CONV_FIELDS, limit: 25 },
    { token, fetchImpl, timeoutMs, maxPages: 2 });
  for (const conv of Array.isArray(r.data) ? r.data : []) {
    if (!conv || !conv.id) continue;
    const known = conversationByConvId(db, conv.id);
    if (known && known.updated_time && known.updated_time === str(conv.updated_time) && known.last_at) continue;
    const peer = peerOf(conv, ownIds);
    db.transaction(() => {
      const row = upsertConversation(db, {
        platform, conv_id: conv.id, peer_id: peer.id, peer_name: peer.name, peer_username: peer.username,
        updated_time: str(conv.updated_time),
      });
      for (const m of list(conv.messages)) {
        if (!m || !m.id) continue;
        const fromId = str(m.from && m.from.id);
        insertMessage(db, row.id, {
          msg_id: String(m.id), direction: ownIds.has(fromId) ? 'out' : 'in',
          text: str(m.message), attachments: parseAttachments(m), created_at: isoZ(m.created_time),
        }, { readBefore });
      }
      refreshConversationSummary(db, row.id);
    })();
  }
  return r.ok ? '' : (r.reason || 'server_error');
}

async function pollFacebookComments(db, ctx) {
  const { pageId, token, readBefore, fetchImpl, timeoutMs } = ctx;
  let failure = '';
  for (const [edge, isAd] of [['feed', false], ['ads_posts', true]]) {
    const r = await graphGetAll(`${pageId}/${edge}`, { fields: FB_POST_FIELDS, limit: 25 }, { token, fetchImpl, timeoutMs, maxPages: 1 });
    for (const post of Array.isArray(r.data) ? r.data : []) {
      if (!post || !post.id) continue;
      // Ответы — после своих родителей: так корень нитки уже лежит в базе.
      const comments = list(post.comments).slice().sort((a, b) => str(a.created_time).localeCompare(str(b.created_time)));
      db.transaction(() => {
        for (const c of comments) {
          if (!c || !c.id) continue;
          const fromId = str(c.from && c.from.id);
          upsertComment(db, {
            platform: 'facebook', comment_id: c.id, parent_id: str(c.parent && c.parent.id),
            post_id: post.id, post_text: str(post.message), post_url: str(post.permalink_url), post_is_ad: isAd,
            author_id: fromId, author_name: str(c.from && c.from.name), text: str(c.message),
            created_at: isoZ(c.created_time), is_page: fromId === pageId, is_hidden: !!c.is_hidden,
          }, { readBefore });
        }
      })();
    }
    // Рекламных постов может не отдать токен без права на рекламу — это не
    // повод молчать об обычных комментариях; слово скажет экрану, чего нет.
    if (!r.ok && !failure) failure = (isAd ? 'ads_' : '') + (r.reason || 'server_error');
  }
  return failure;
}

async function pollInstagramComments(db, ctx) {
  const { igId, igUsername, token, readBefore, fetchImpl, timeoutMs } = ctx;
  const r = await graphGetAll(`${igId}/media`, { fields: IG_MEDIA_FIELDS, limit: 25 }, { token, fetchImpl, timeoutMs, maxPages: 1 });
  const own = (c) => str(c.from && c.from.id) === igId || (igUsername && str(c.username) === igUsername);
  for (const media of Array.isArray(r.data) ? r.data : []) {
    if (!media || !media.id) continue;
    db.transaction(() => {
      const put = (c, parentId) => upsertComment(db, {
        platform: 'instagram', comment_id: c.id, parent_id: parentId,
        post_id: media.id, post_text: str(media.caption), post_url: str(media.permalink),
        author_id: str(c.from && c.from.id), author_name: str(c.username || (c.from && c.from.username)),
        text: str(c.text), created_at: isoZ(c.timestamp), is_page: !!own(c), is_hidden: !!c.hidden,
      }, { readBefore });
      for (const c of list(media.comments)) {
        if (!c || !c.id) continue;
        put(c, '');
        for (const rep of list(c.replies)) if (rep && rep.id) put(rep, c.id);
      }
    })();
  }
  return r.ok ? '' : (r.reason || 'server_error');
}

let inFlight = false;

/** Один проход. Никогда не бросает — для таймера, «Обновить сейчас» и тестов. */
export async function pollInboxOnce(db, opts = {}) {
  if (inFlight) return;
  inFlight = true;
  try {
    await performPoll(db, opts);
  } catch (e) {
    console.warn('[meta-inbox] poll failed, will retry next tick:', e && e.message);
  } finally {
    inFlight = false;
  }
}

async function performPoll(db, opts = {}) {
  const { hasModule = defaultHasModule, fetchImpl, timeoutMs, kekPath } = opts;
  const st = readInboxState(db);
  if (!st || !st.enabled) return;
  if (!hasModule(db)) return;
  const settings = readSettingsRow(db) || {};
  const pageId = str(settings.page_id);
  if (!settings.token_sealed || !pageId) { recordInboxPoll(db, { errors: { messenger: 'no_page' } }); return; }

  let tokens;
  try { tokens = getTokens(db, { kekPath }); }
  catch (e) {
    console.warn('[meta-inbox] token unreadable:', e && e.message);
    recordInboxPoll(db, { errors: { messenger: 'kek' } });
    return;
  }
  const token = tokens.pageToken || tokens.token;
  if (!token) { recordInboxPoll(db, { errors: { messenger: 'no_token' } }); return; }

  const errors = {};
  let ig = null;
  const igr = await graphGet(pageId, { fields: 'instagram_business_account{id,username}' }, { token, fetchImpl, timeoutMs });
  if (igr.ok) {
    const a = igr.data && igr.data.instagram_business_account;
    ig = { id: str(a && a.id), username: str(a && a.username) };
  } else {
    errors.ig = igr.reason || 'server_error';
    // Нет сети или токен недействителен — остальные части ответят тем же.
    if (igr.reason === 'offline' || igr.reason === 'bad_token') { recordInboxPoll(db, { errors }); return; }
  }
  const igId = ig ? ig.id : str(st.ig_account_id);
  const igUsername = ig ? ig.username : str(st.ig_username);
  const ctx = {
    pageId, igId, igUsername, token, fetchImpl, timeoutMs,
    ownIds: new Set([pageId, igId].filter(Boolean)),
    readBefore: st.enabled_at || null,
  };

  errors.messenger = await pollConversations(db, 'messenger', ctx);
  errors.facebook = await pollFacebookComments(db, ctx);
  if (igId) {
    errors.instagram = await pollConversations(db, 'instagram', ctx);
    errors.instagram_comments = await pollInstagramComments(db, ctx);
  }
  recordInboxPoll(db, { errors, ig });
}

// --------------------------------------------------------------------------
// Расписание — форма poller.js schedulePolling: таймер unref, период постоянный.
// --------------------------------------------------------------------------
let timer = null;
let stopped = false;
let armFn = null;

/** Из rpc/meta-inbox.js после включения: первый проход через секунды, а не через минуту. */
export function wakeInboxPolling() {
  if (armFn) armFn(0);
}

export function scheduleInboxPolling(db, opts = {}) {
  const { initialDelayMs = INITIAL_DELAY_MS, ...tickOpts } = opts;
  stopped = false;
  const arm = (ms) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
    if (timer.unref) timer.unref();
  };
  const tick = () => {
    pollInboxOnce(db, tickOpts)
      .catch((e) => console.warn('[meta-inbox] scheduled poll failed:', e && e.message))
      .finally(() => arm(INBOX_PERIOD_MS));
  };
  armFn = arm;
  arm(initialDelayMs);
  console.log('[meta-inbox] message poller scheduled');
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      armFn = null;
    },
  };
}
