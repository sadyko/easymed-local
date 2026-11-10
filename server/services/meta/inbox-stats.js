// META_INBOX_STATS_V1 — статистика «Чата Facebook и Instagram».
//
// Владелец (2026-10-31): «can you build statistics page button on top, page
// should show how many comments arrived how many private masseges, how many
// leads generated from chats and so on detailed stattistics».
//
// Считается только из того, что опрос уже положил в базу (meta_messages,
// meta_comments): Meta здесь не спрашивается, страница открывается и без сети.
// Отсюда граница: то, чего опрос не видел (Instagram Direct без права
// instagram_manage_messages), в статистику не попадает — экран это говорит.
//
// Дни — местные (domain/day.js): «сегодня» владельца начинается в местную
// полночь, а не в 05:00 по UTC.
//
// Слова, которые экран показывает:
//   * обращение — серия входящих подряд до ответа клиники. Пять сообщений
//     «здравствуйте / сколько стоит / …» — одно обращение и один ответ, иначе
//     время ответа считалось бы от последнего, а не от первого вопроса;
//   * пропущено — обращение без ответа, у которого окно Meta (24 ч) уже
//     закрылось: ответить на него из программы больше нельзя;
//   * ответ «вне Easy-Med» — исходящее без сотрудника: ответили в Meta Business
//     Suite или с телефона. Оно считается ответом, но без имени.

import { today, localDate, localMonth } from '../domain/day.js';
import { noShowStageKey, effectiveKind } from '../crm/config.js';   // CRM_NO_SHOW_ANY_COLUMN_V1 (ревью F4)

export const STATS_PERIODS = Object.freeze([1, 7, 30, 90, 0]);   // 0 — всё время
export const CHANNELS = Object.freeze(['messenger', 'instagram', 'facebook', 'instagram_comments']);

const WINDOW_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
// Длиннее — по месяцам: 400 столбиков по дню не читаются.
const MAX_DAY_BUCKETS = 92;

const inRange = (col) => `${localDate(col)} BETWEEN ? AND ?`;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function blankChannel(key) {
  return { key, incoming: 0, people: 0, requests: 0, answered: 0, waiting: 0, missed: 0, within_hour: 0, median_ms: null, leads: 0, _times: [], _people: new Set() };
}

/** Даты периода: { days, from, to } — местные 'YYYY-MM-DD'. */
export function statsRange(db, days) {
  const d = STATS_PERIODS.includes(Number(days)) ? Number(days) : 30;
  const to = today(db);
  if (d) return { days: d, from: db.prepare('SELECT date(?, ?) AS d').get(to, `-${d - 1} days`).d, to };
  const first = db.prepare(`SELECT MIN(d) AS d FROM (
      SELECT MIN(${localDate('created_at')}) AS d FROM meta_messages
      UNION ALL SELECT MIN(${localDate('created_at')}) FROM meta_comments)`).get().d;
  return { days: 0, from: first && first < to ? first : to, to };
}

function buckets(db, range) {
  if (range.days === 1) {
    return { unit: 'hour', keys: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')) };
  }
  const span = db.prepare('SELECT julianday(?) - julianday(?) AS n').get(range.to, range.from).n + 1;
  if (span <= MAX_DAY_BUCKETS) {
    const keys = [];
    for (let i = 0; i < span; i++) keys.push(db.prepare('SELECT date(?, ?) AS d').get(range.from, `+${i} days`).d);
    return { unit: 'day', keys };
  }
  const keys = [];
  let m = range.from.slice(0, 7);
  const last = range.to.slice(0, 7);
  while (m <= last) {
    keys.push(m);
    m = db.prepare("SELECT strftime('%Y-%m', date(? || '-01', '+1 month')) AS m").get(m).m;
  }
  return { unit: 'month', keys };
}

/**
 * from / to (местные 'YYYY-MM-DD') — произвольный период вместо days: обзор
 * клиники (rpc/dashboard-overview.js) считает свой период теми же словами
 * «обращение», «пропущено», «ответ», что и этот экран.
 */
export function inboxStats(db, { days = 30, nowMs = Date.now(), from = null, to = null } = {}) {
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  const range = (from && to && ymd.test(from) && ymd.test(to) && from <= to)
    ? { days: -1, from, to }
    : statsRange(db, days);
  const R = [range.from, range.to];
  const { unit, keys } = buckets(db, range);
  const bucketCol = (col) => (unit === 'hour' ? `strftime('%H', ${col}, 'localtime')` : unit === 'month' ? localMonth(col) : localDate(col));

  const series = new Map(keys.map((k) => [k, { key: k, messenger: 0, instagram: 0, facebook: 0, instagram_comments: 0, replies: 0 }]));
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
  const ch = Object.fromEntries(CHANNELS.map((k) => [k, blankChannel(k)]));
  const staff = new Map();
  const staffRow = (id) => {
    if (!staff.has(id)) staff.set(id, { user_id: id, messages: 0, comment_replies: 0, private_replies: 0, leads: 0 });
    return staff.get(id);
  };
  const outside = { messages: 0, comment_replies: 0 };
  const bump = (bucket, field, n = 1) => { const b = series.get(bucket); if (b) b[field] += n; };

  // ---- Личные сообщения ---------------------------------------------------
  const msgs = db.prepare(`
    SELECT m.id, m.conversation_id AS conv, c.platform, m.direction, m.status, m.sent_by,
           ${bucketCol('m.created_at')} AS bucket, CAST(strftime('%H', m.created_at, 'localtime') AS INTEGER) AS hour
      FROM meta_messages m JOIN meta_conversations c ON c.id = m.conversation_id
     WHERE ${inRange('m.created_at')}`).all(...R);
  let failed = 0;
  const inPeriod = new Set();
  for (const m of msgs) {
    if (m.direction === 'in') {
      inPeriod.add(m.id);
      ch[m.platform].incoming++;
      ch[m.platform]._people.add(m.conv);
      bump(m.bucket, m.platform);
      if (hours[m.hour]) hours[m.hour].count++;
    } else if (m.status === 'failed') {
      failed++;
    } else {
      bump(m.bucket, 'replies');
      if (m.sent_by) staffRow(m.sent_by).messages++; else outside.messages++;
    }
  }

  // Обращения и время ответа: вся переписка тех, кто писал в период, — ответ
  // может прийти уже после конца периода, и он всё равно ответ.
  if (inPeriod.size) {
    const all = db.prepare(`
      SELECT m.id, m.conversation_id AS conv, c.platform, m.direction, m.status, m.created_at
        FROM meta_messages m JOIN meta_conversations c ON c.id = m.conversation_id
       WHERE m.conversation_id IN (SELECT conversation_id FROM meta_messages WHERE direction = 'in' AND ${inRange('created_at')})
       ORDER BY m.conversation_id, m.created_at, m.id`).all(...R);
    let open = null;   // { id, at, platform } — первое входящее без ответа
    let conv = null;
    const close = () => {
      if (open && inPeriod.has(open.id)) {
        const c = ch[open.platform];
        c.requests++;
        if (nowMs - open.at > WINDOW_MS) c.missed++; else c.waiting++;
      }
      open = null;
    };
    for (const m of all) {
      if (m.conv !== conv) { close(); conv = m.conv; }
      const at = Date.parse(m.created_at);
      if (m.direction === 'in') {
        if (!open) open = { id: m.id, at, platform: m.platform };
      } else if (m.status !== 'failed' && open) {
        if (inPeriod.has(open.id)) {
          const c = ch[open.platform];
          c.requests++; c.answered++;
          const dt = Math.max(0, at - open.at);
          c._times.push(dt);
          if (dt <= HOUR_MS) c.within_hour++;
        }
        open = null;
      }
    }
    close();
  }

  // ---- Комментарии --------------------------------------------------------
  const comments = db.prepare(`
    SELECT id, platform, comment_id, root_id, post_id, post_text, post_url, post_is_ad, author_id, is_page, is_hidden,
           sent_by, crm_request_id, created_at,
           ${bucketCol('created_at')} AS bucket, CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hour
      FROM meta_comments WHERE ${inRange('created_at')}`).all(...R);
  // Первый ответ клиники по нитке — публичный или в личку, когда бы он ни был.
  const firstAnswer = new Map(db.prepare(`
    SELECT root, MIN(at) AS at FROM (
      SELECT root_id AS root, created_at AS at FROM meta_comments WHERE is_page = 1 AND root_id <> ''
      UNION ALL
      SELECT CASE WHEN root_id = '' THEN comment_id ELSE root_id END, private_replied_at FROM meta_comments WHERE private_replied_at IS NOT NULL
    ) GROUP BY root`).all().map((r) => [r.root, Date.parse(r.at)]));

  const posts = new Map();
  let onAds = 0, hidden = 0;
  for (const c of comments) {
    const key = c.platform === 'instagram' ? 'instagram_comments' : 'facebook';
    if (c.is_page) {
      bump(c.bucket, 'replies');
      if (c.sent_by) staffRow(c.sent_by).comment_replies++; else outside.comment_replies++;
      continue;
    }
    const k = ch[key];
    k.incoming++;
    if (c.author_id) k._people.add(c.author_id);
    bump(c.bucket, key);
    if (hours[c.hour]) hours[c.hour].count++;
    if (c.post_is_ad) onAds++;
    if (c.is_hidden) hidden++;

    if (!c.root_id) {   // нитка = комментарий верхнего уровня
      k.requests++;
      const ans = firstAnswer.get(c.comment_id);
      if (Number.isFinite(ans)) {
        k.answered++;
        const dt = Math.max(0, ans - Date.parse(c.created_at));
        k._times.push(dt);
        if (dt <= HOUR_MS) k.within_hour++;
      } else if (!c.is_hidden) {
        k.waiting++;   // у комментария окна нет: ответить можно и позже
      }
    }

    const pk = c.platform + ':' + (c.post_id || '');
    if (!posts.has(pk)) {
      posts.set(pk, { platform: c.platform, post_id: c.post_id, post_text: (c.post_text || '').slice(0, 160), post_url: c.post_url,
        is_ad: !!c.post_is_ad, comments: 0, _people: new Set(), _leads: new Set() });
    }
    const p = posts.get(pk);
    p.comments++;
    if (c.author_id) p._people.add(c.author_id);
    if (c.crm_request_id) p._leads.add(c.crm_request_id);
  }

  const privateRows = db.prepare(`SELECT sent_by FROM meta_comments WHERE private_replied_at IS NOT NULL AND ${inRange('private_replied_at')}`).all(...R);
  for (const r of privateRows) {
    if (r.sent_by) staffRow(r.sent_by).private_replies++;
  }

  // ---- Лиды ---------------------------------------------------------------
  // По дате связи (мигр. 264). Одна карточка из двух мест — один лид.
  const leadRows = db.prepare(`
    SELECT x.channel, x.crm, x.by, x.kind, r.patient_id, s.key AS stage_key, s.label AS stage_label, s.kind AS stage_kind, s.position, s.color
      FROM (
        SELECT platform AS channel, crm_request_id AS crm, crm_linked_by AS by, crm_link_kind AS kind, crm_linked_at AS at
          FROM meta_conversations WHERE crm_request_id IS NOT NULL AND crm_linked_at IS NOT NULL
        UNION ALL
        SELECT CASE platform WHEN 'instagram' THEN 'instagram_comments' ELSE 'facebook' END, crm_request_id, crm_linked_by, crm_link_kind, crm_linked_at
          FROM meta_comments WHERE crm_request_id IS NOT NULL AND crm_linked_at IS NOT NULL
      ) x
      JOIN crm_requests r ON r.id = x.crm
      LEFT JOIN crm_stages s ON s.key = r.status
     WHERE ${inRange('x.at')}
     ORDER BY x.at`).all(...R);
  const seen = new Set();
  const stages = new Map();
  const noShow = noShowStageKey(db);   // CRM_NO_SHOW_ANY_COLUMN_V1 (ревью F4)
  const leads = { total: 0, created: 0, merged: 0, won: 0, lost: 0, open: 0, patients: 0 };
  for (const l of leadRows) {
    if (seen.has(l.crm)) continue;
    seen.add(l.crm);
    leads.total++;
    if (l.kind === 'merged') leads.merged++; else leads.created++;
    if (l.patient_id) leads.patients++;
    // CRM_NO_SHOW_ANY_COLUMN_V1 (ревью F4) — колонка «Не пришёл» (бывает открытой) — потеря.
    const kind = (l.stage_key ? effectiveKind({ key: l.stage_key, kind: l.stage_kind }, noShow) : null) || 'open';
    leads[kind] = (leads[kind] || 0) + 1;
    if (ch[l.channel]) ch[l.channel].leads++;
    if (l.by) staffRow(l.by).leads++;
    const sk = l.stage_key || '?';
    if (!stages.has(sk)) stages.set(sk, { key: sk, label: l.stage_label || sk, kind, color: l.color || '', position: l.position ?? 999, count: 0 });
    stages.get(sk).count++;
  }

  // ---- Сейчас ждут ответа (не зависит от периода) -------------------------
  const nowIso = new Date(nowMs - WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const waitingNow = {
    messages: db.prepare(`SELECT COUNT(*) AS n FROM meta_conversations WHERE last_direction = 'in' AND last_in_at > ?`).get(nowIso).n,
    comments: db.prepare(`
      SELECT COUNT(*) AS n FROM meta_comments c
       WHERE c.is_page = 0 AND c.root_id = '' AND c.is_hidden = 0 AND c.private_replied_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM meta_comments p WHERE p.is_page = 1 AND p.root_id = c.comment_id)`).get().n,
  };

  // ---- Сборка -------------------------------------------------------------
  const ids = [...staff.keys()];
  const names = ids.length
    ? new Map(db.prepare(`SELECT id, full_name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((u) => [u.id, u.full_name || '']))
    : new Map();

  const channels = CHANNELS.map((k) => {
    const c = ch[k];
    const { _times, _people, ...rest } = c;
    return { ...rest, people: _people.size, median_ms: median(_times) };
  });
  const sum = (f, ks = CHANNELS) => ks.reduce((n, k) => n + (channels.find((c) => c.key === k)[f] || 0), 0);
  const allTimes = CHANNELS.flatMap((k) => ch[k]._times);
  const msgTimes = [...ch.messenger._times, ...ch.instagram._times];
  const people = sum('people');

  return {
    range: { ...range, unit },
    totals: {
      messages_in: sum('incoming', ['messenger', 'instagram']),
      message_people: sum('people', ['messenger', 'instagram']),
      messages_out: [...staff.values()].reduce((n, s) => n + s.messages, 0) + outside.messages,
      messages_failed: failed,
      comments_in: sum('incoming', ['facebook', 'instagram_comments']),
      comment_people: sum('people', ['facebook', 'instagram_comments']),
      comments_on_ads: onAds,
      comments_hidden: hidden,
      comment_replies: [...staff.values()].reduce((n, s) => n + s.comment_replies, 0) + outside.comment_replies,
      private_replies: privateRows.length,
      requests: sum('requests'),
      answered: sum('answered'),
      missed: sum('missed'),
      within_hour: sum('within_hour'),
      median_ms: median(allTimes),
      message_median_ms: median(msgTimes),
      people,
      leads: leads.total,
      conversion: people ? leads.total / people : null,
    },
    leads,
    stages: [...stages.values()].sort((a, b) => a.position - b.position),
    channels,
    series: [...series.values()],
    hours,
    posts: [...posts.values()]
      .map(({ _people, _leads, ...p }) => ({ ...p, people: _people.size, leads: _leads.size }))
      .sort((a, b) => b.comments - a.comments)
      .slice(0, 8),
    staff: [...staff.values()]
      .map((s) => ({ ...s, name: names.get(s.user_id) || '' }))
      .sort((a, b) => (b.messages + b.comment_replies + b.private_replies) - (a.messages + a.comment_replies + a.private_replies)),
    outside,
    waiting_now: waitingNow,
  };
}
