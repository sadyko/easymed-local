// META_INBOX_V1 — хранилище «Чата Facebook и Instagram» (мигр. 263).
//
// Опрос (inbox-poller.js) кладёт сюда то, что прочитал у Meta, действия
// (inbox-actions.js) — то, что клиника ответила; экран читает только отсюда.
// Каждая запись идемпотентна по id Meta: опрос перечитывает одно и то же окно
// и не должен плодить строк.
//
// Время — строкой ISO с «Z» без миллисекунд, как strftime(...) в остальной базе:
// сравнение строк тогда совпадает со сравнением времени.

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

/** «2026-10-31T10:00:00+0000» (Meta) → «2026-10-31T10:00:00Z». Непонятное — '' (не бросает). */
export function isoZ(v) {
  const t = Date.parse(String(v || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isFinite(t) ? new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z') : '';
}
export function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

// ---------------------------------------------------------------------------
// Состояние опроса
// ---------------------------------------------------------------------------
export function readInboxState(db) {
  let row = null;
  try { row = db.prepare('SELECT * FROM meta_inbox_state WHERE id = 1').get() || null; } catch { row = null; }
  if (!row) return null;
  let errors = {};
  try { const o = JSON.parse(row.errors_json || '{}'); errors = o && typeof o === 'object' ? o : {}; } catch { errors = {}; }
  return { ...row, enabled: !!row.enabled, errors };
}

export function setInboxEnabled(db, on, userId = null) {
  db.prepare(`UPDATE meta_inbox_state SET
      enabled = @on,
      enabled_at = CASE WHEN @on = 1 AND (enabled = 0 OR enabled_at IS NULL) THEN ${NOW_SQL} ELSE enabled_at END,
      errors_json = CASE WHEN @on = 1 THEN '{}' ELSE errors_json END,
      updated_at = ${NOW_SQL}, updated_by = @userId
    WHERE id = 1`).run({ on: on ? 1 : 0, userId });
  return readInboxState(db);
}

/** След прохода: слово причины по каждой части; без слов — удача. Недействительный токен выключает опрос. */
export function recordInboxPoll(db, { errors = {}, ig = null } = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(errors || {})) if (v) clean[k] = String(v).slice(0, 40);
  const ok = Object.keys(clean).length === 0;
  const badToken = Object.values(clean).includes('bad_token');
  db.prepare(`UPDATE meta_inbox_state SET
      last_poll_at = ${NOW_SQL},
      last_ok_at = CASE WHEN @ok THEN ${NOW_SQL} ELSE last_ok_at END,
      errors_json = @errors,
      ig_account_id = COALESCE(@igId, ig_account_id),
      ig_username = COALESCE(@igName, ig_username),
      enabled = CASE WHEN @badToken THEN 0 ELSE enabled END
    WHERE id = 1`).run({
    ok: ok ? 1 : 0, errors: JSON.stringify(clean), badToken: badToken ? 1 : 0,
    igId: ig ? String(ig.id || '') : null, igName: ig ? String(ig.username || '') : null,
  });
}

// ---------------------------------------------------------------------------
// Переписка
// ---------------------------------------------------------------------------
export function conversationByConvId(db, convId) {
  return db.prepare('SELECT * FROM meta_conversations WHERE conv_id = ?').get(String(convId)) || null;
}

/** Завести или обновить переписку. Возвращает строку. */
export function upsertConversation(db, c) {
  db.prepare(`INSERT INTO meta_conversations (platform, conv_id, peer_id, peer_name, peer_username, updated_time)
              VALUES (@platform, @conv_id, @peer_id, @peer_name, @peer_username, @updated_time)
              ON CONFLICT(conv_id) DO UPDATE SET
                peer_id = CASE WHEN excluded.peer_id <> '' THEN excluded.peer_id ELSE peer_id END,
                peer_name = CASE WHEN excluded.peer_name <> '' THEN excluded.peer_name ELSE peer_name END,
                peer_username = CASE WHEN excluded.peer_username <> '' THEN excluded.peer_username ELSE peer_username END,
                updated_time = excluded.updated_time`).run({
    platform: c.platform, conv_id: String(c.conv_id),
    peer_id: String(c.peer_id || ''), peer_name: String(c.peer_name || '').slice(0, 200),
    peer_username: String(c.peer_username || '').slice(0, 100), updated_time: c.updated_time || null,
  });
  return conversationByConvId(db, c.conv_id);
}

/**
 * Сообщение по id Meta; повтор — ничего. `readBefore` — время включения
 * опроса: входящее старше него приходит прочитанным (история, а не новое).
 * Возвращает true, если строка новая.
 */
export function insertMessage(db, convRowId, m, { readBefore = null } = {}) {
  const created = m.created_at || nowIso();
  const read = m.direction === 'out' || (readBefore && created < readBefore) ? created : null;
  const r = db.prepare(`INSERT INTO meta_messages (conversation_id, msg_id, direction, text, attachments_json, created_at, read_at, sent_by)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(msg_id) DO NOTHING`)
    .run(convRowId, m.msg_id || null, m.direction, String(m.text || '').slice(0, 20000),
      JSON.stringify(Array.isArray(m.attachments) ? m.attachments : []), created, m.read_at || read, m.sent_by || null);
  return r.changes > 0;
}

/** Последнее сообщение и последнее входящее — в строку переписки (список и окно 24 часа). */
export function refreshConversationSummary(db, convRowId) {
  const last = db.prepare(`SELECT text, attachments_json, direction, created_at FROM meta_messages
                            WHERE conversation_id = ? AND status = 'ok' ORDER BY created_at DESC, id DESC LIMIT 1`).get(convRowId);
  const lastIn = db.prepare(`SELECT MAX(created_at) AS t FROM meta_messages WHERE conversation_id = ? AND direction = 'in'`).get(convRowId);
  let text = last ? last.text : '';
  if (last && !text) {
    try { if (JSON.parse(last.attachments_json || '[]').length) text = '[вложение]'; } catch { /* пусто */ }
  }
  db.prepare('UPDATE meta_conversations SET last_text = ?, last_direction = ?, last_at = ?, last_in_at = ? WHERE id = ?')
    .run(String(text || '').slice(0, 300), last ? last.direction : 'in', last ? last.created_at : null, (lastIn && lastIn.t) || null, convRowId);
}

export function listConversations(db, { limit = 300 } = {}) {
  return db.prepare(`
    SELECT c.id, c.platform, c.peer_name, c.peer_username, c.last_text, c.last_direction, c.last_at, c.last_in_at,
           c.crm_request_id,
           (SELECT COUNT(*) FROM meta_messages m WHERE m.conversation_id = c.id AND m.direction = 'in' AND m.read_at IS NULL) AS unread
      FROM meta_conversations c
     WHERE c.last_at IS NOT NULL
     ORDER BY c.last_at DESC, c.id DESC
     LIMIT ?`).all(limit).map((r) => ({ ...r, unread: Number(r.unread) || 0 }));
}

export function conversationById(db, id) {
  return db.prepare('SELECT * FROM meta_conversations WHERE id = ?').get(Number(id)) || null;
}

export function conversationMessages(db, id, { limit = 300 } = {}) {
  const rows = db.prepare(`SELECT id, direction, text, attachments_json, created_at, status, error, sent_by
                             FROM meta_messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(Number(id), limit);
  return rows.reverse().map(({ attachments_json, ...m }) => {
    let attachments = [];
    try { const a = JSON.parse(attachments_json || '[]'); attachments = Array.isArray(a) ? a : []; } catch { attachments = []; }
    return { ...m, attachments };
  });
}

export function markConversationRead(db, id) {
  db.prepare(`UPDATE meta_messages SET read_at = ${NOW_SQL} WHERE conversation_id = ? AND direction = 'in' AND read_at IS NULL`).run(Number(id));
}

// ---------------------------------------------------------------------------
// Комментарии
// ---------------------------------------------------------------------------
export function commentById(db, id) {
  return db.prepare('SELECT * FROM meta_comments WHERE id = ?').get(Number(id)) || null;
}

/**
 * Комментарий по id Meta. Повтор обновляет то, что меняется у Meta (текст,
 * скрыт ли, подпись поста), и не трогает наше (прочитан, ответ в личку, CRM).
 * Нитка: корень — корень родителя, если родитель у нас есть, иначе сам родитель.
 */
export function upsertComment(db, c, { readBefore = null } = {}) {
  const parent = String(c.parent_id || '');
  let root = '';
  if (parent) {
    const p = db.prepare('SELECT root_id, comment_id FROM meta_comments WHERE comment_id = ?').get(parent);
    root = p ? (p.root_id || p.comment_id) : parent;
  }
  const created = c.created_at || nowIso();
  const read = c.is_page || (readBefore && created < readBefore) ? created : null;
  const r = db.prepare(`INSERT INTO meta_comments (platform, comment_id, parent_id, root_id, post_id, post_text, post_url, post_is_ad,
                          author_id, author_name, text, created_at, is_page, is_hidden, read_at, sent_by)
                        VALUES (@platform, @comment_id, @parent_id, @root_id, @post_id, @post_text, @post_url, @post_is_ad,
                          @author_id, @author_name, @text, @created_at, @is_page, @is_hidden, @read_at, @sent_by)
                        ON CONFLICT(comment_id) DO UPDATE SET
                          text = excluded.text, is_hidden = excluded.is_hidden,
                          post_text = CASE WHEN excluded.post_text <> '' THEN excluded.post_text ELSE post_text END,
                          post_url = CASE WHEN excluded.post_url <> '' THEN excluded.post_url ELSE post_url END,
                          author_name = CASE WHEN excluded.author_name <> '' THEN excluded.author_name ELSE author_name END`).run({
    platform: c.platform, comment_id: String(c.comment_id), parent_id: parent, root_id: root,
    post_id: String(c.post_id || ''), post_text: String(c.post_text || '').slice(0, 2000), post_url: String(c.post_url || '').slice(0, 500),
    post_is_ad: c.post_is_ad ? 1 : 0, author_id: String(c.author_id || ''), author_name: String(c.author_name || '').slice(0, 200),
    text: String(c.text || '').slice(0, 8000), created_at: created, is_page: c.is_page ? 1 : 0, is_hidden: c.is_hidden ? 1 : 0,
    read_at: c.read_at || read, sent_by: c.sent_by || null,
  });
  return r.changes > 0;
}

const rootKey = (c) => c.root_id || c.comment_id;

/**
 * Нитки комментариев, свежие вперёд. Корень нитки — комментарий верхнего
 * уровня; если его у нас нет (ответ под старым комментарием, который опрос уже
 * не видит), ниткой считается самый ранний известный комментарий.
 */
export function listCommentThreads(db, { limit = 200 } = {}) {
  const rows = db.prepare(`SELECT id, platform, comment_id, root_id, post_id, post_text, post_url, post_is_ad, author_name, text,
                                  created_at, is_page, is_hidden, read_at, private_replied_at, crm_request_id
                             FROM meta_comments ORDER BY created_at DESC, id DESC LIMIT 3000`).all();
  const threads = new Map();
  for (const r of rows) {
    const k = rootKey(r);
    let t = threads.get(k);
    if (!t) { t = { key: k, rows: [] }; threads.set(k, t); }
    t.rows.push(r);
  }
  const out = [];
  for (const t of threads.values()) {
    const root = t.rows.find((r) => r.comment_id === t.key) || t.rows[t.rows.length - 1];
    const latest = t.rows[0];
    const lastOther = t.rows.find((r) => !r.is_page) || latest;
    out.push({
      id: root.id, platform: root.platform, post_text: root.post_text, post_url: root.post_url, post_is_ad: !!root.post_is_ad,
      author_name: lastOther.author_name, text: lastOther.text, last_is_page: !!latest.is_page,
      last_at: latest.created_at, replies: t.rows.length - 1,
      unread: t.rows.filter((r) => !r.is_page && !r.read_at).length,
      answered: t.rows.some((r) => r.is_page) || t.rows.some((r) => r.private_replied_at),
      is_hidden: !!root.is_hidden, crm_request_id: t.rows.find((r) => r.crm_request_id)?.crm_request_id || null,
    });
  }
  out.sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : b.id - a.id));
  return out.slice(0, limit);
}

/** Нитка по строке любого её комментария: корень и все ответы по времени. */
export function commentThread(db, id) {
  const any = commentById(db, id);
  if (!any) return null;
  const key = rootKey(any);
  const rows = db.prepare(`SELECT * FROM meta_comments WHERE comment_id = ? OR root_id = ? ORDER BY created_at ASC, id ASC`).all(key, key);
  const root = rows.find((r) => r.comment_id === key) || rows[0];
  return { key, root, comments: rows };
}

export function markThreadRead(db, key) {
  db.prepare(`UPDATE meta_comments SET read_at = ${NOW_SQL} WHERE (comment_id = ? OR root_id = ?) AND read_at IS NULL`).run(key, key);
}

/** Непрочитанное — для значка меню и счётчиков вкладок. */
export function unreadCounts(db) {
  try {
    const m = db.prepare(`SELECT c.platform, COUNT(*) AS n FROM meta_messages m JOIN meta_conversations c ON c.id = m.conversation_id
                           WHERE m.direction = 'in' AND m.read_at IS NULL GROUP BY c.platform`).all();
    const cm = db.prepare('SELECT COUNT(*) AS n FROM meta_comments WHERE is_page = 0 AND read_at IS NULL').get();
    const out = { messenger: 0, instagram: 0, comments: Number(cm.n) || 0 };
    for (const r of m) out[r.platform] = Number(r.n) || 0;
    out.total = out.messenger + out.instagram + out.comments;
    return out;
  } catch { return { messenger: 0, instagram: 0, comments: 0, total: 0 }; }   // база без миграции 263
}
