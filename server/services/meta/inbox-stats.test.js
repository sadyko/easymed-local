// META_INBOX_STATS_V1 — статистика «Чата Facebook и Instagram» (inbox-stats.js).
//
// Что закреплено:
//   * обращение — серия входящих до ответа: три вопроса подряд и ответ — одно
//     обращение, время ответа — от ПЕРВОГО вопроса;
//   * без ответа дольше 24 часов — «пропущено», моложе — «ждёт»;
//   * комментарий: нитка отвечена публичным ответом или ответом в личку;
//     ответ без сотрудника — «вне Easy-Med»;
//   * лид считается по моменту «Отметить как лид» и записывает сотрудника;
//   * права — как у чтения переписки; RPC зарегистрирован.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { inboxStats } from './inbox-stats.js';
import { toCrm } from './inbox-actions.js';
import { metaInboxStats } from '../rpc/meta-inbox.js';
import { getRpc } from '../rpc/index.js';

const MIN = 60 * 1000, HOUR = 60 * MIN;
const NOW = Date.now();
const at = (msAgo) => new Date(NOW - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin', 'Администратор');
  ins.run(3, 'reg', 'x', 'registrar', 'Регистратор');

  const conv = db.prepare(`INSERT INTO meta_conversations (platform, conv_id, last_direction, last_in_at) VALUES (?, ?, 'in', ?) RETURNING id`);
  const msg = db.prepare(`INSERT INTO meta_messages (conversation_id, msg_id, direction, created_at, sent_by) VALUES (?, ?, ?, ?, ?)`);
  // Messenger: три вопроса подряд → ответ через 30 мин от первого; потом новый вопрос без ответа (ждёт).
  const a = conv.get('messenger', 't_a', at(1 * HOUR)).id;
  msg.run(a, 'm1', 'in', at(3 * HOUR), null);
  msg.run(a, 'm2', 'in', at(3 * HOUR - MIN), null);
  msg.run(a, 'm3', 'in', at(3 * HOUR - 2 * MIN), null);
  msg.run(a, 'm4', 'out', at(2.5 * HOUR), 1);
  msg.run(a, 'm5', 'in', at(1 * HOUR), null);
  // Direct: вопрос 30 часов назад без ответа — окно закрылось.
  const b = conv.get('instagram', 't_b', at(30 * HOUR)).id;
  msg.run(b, 'm6', 'in', at(30 * HOUR), null);

  const cm = db.prepare(`INSERT INTO meta_comments (platform, comment_id, root_id, post_id, post_text, post_is_ad, author_id, is_page, created_at, private_replied_at, sent_by)
                         VALUES (@platform, @id, @root, @post, @text, @ad, @author, @page, @at, @priv, @by)`);
  const base = { root: '', post: 'p1', text: 'Акция на УЗИ', ad: 0, author: '', page: 0, priv: null, by: null };
  // Instagram: комментарий, ответ человека в нитке, ответ клиники из Meta (без сотрудника) через час.
  cm.run({ ...base, platform: 'instagram', id: 'c1', author: 'a1', at: at(5 * HOUR) });
  cm.run({ ...base, platform: 'instagram', id: 'c1r', root: 'c1', author: 'a3', at: at(4.5 * HOUR) });
  cm.run({ ...base, platform: 'instagram', id: 'c1p', root: 'c1', page: 1, at: at(4 * HOUR) });
  // Facebook, под рекламой: ответ в личку сотрудником через час.
  cm.run({ ...base, platform: 'facebook', id: 'c2', post: 'p2', text: 'Реклама', ad: 1, author: 'a2', at: at(2 * HOUR), priv: at(1 * HOUR), by: 1 });
  return db;
}

test('статистика: обращения, время ответа, пропущенные, комментарии, ответы и лиды', () => {
  const db = fresh();
  const c2 = db.prepare("SELECT id FROM meta_comments WHERE comment_id = 'c2'").get().id;
  const r = toCrm(db, { kind: 'comment', id: c2, userId: 1 });
  assert.equal(r.ok, true);
  const link = db.prepare('SELECT crm_linked_at, crm_linked_by, crm_link_kind FROM meta_comments WHERE id = ?').get(c2);
  assert.ok(link.crm_linked_at, 'момент связи записан');
  assert.equal(link.crm_linked_by, 1);
  assert.equal(link.crm_link_kind, 'created');

  const s = inboxStats(db, { days: 7, nowMs: NOW });
  const ch = Object.fromEntries(s.channels.map((c) => [c.key, c]));

  assert.equal(s.totals.messages_in, 5);
  assert.equal(s.totals.message_people, 2);
  assert.equal(s.totals.messages_out, 1);

  assert.equal(ch.messenger.requests, 2, 'три вопроса подряд и ответ — одно обращение, новый вопрос — второе');
  assert.equal(ch.messenger.answered, 1);
  assert.equal(ch.messenger.waiting, 1);
  assert.equal(ch.messenger.median_ms, 30 * MIN, 'от первого вопроса, а не от последнего');
  assert.equal(ch.instagram.missed, 1, 'старше 24 часов без ответа — пропущено');

  assert.equal(s.totals.comments_in, 3, 'ответы клиники в комментарии не входят');
  assert.equal(s.totals.comment_people, 3);
  assert.equal(s.totals.comments_on_ads, 1);
  assert.equal(ch.instagram_comments.requests, 1, 'нитка — одно обращение');
  assert.equal(ch.instagram_comments.answered, 1);
  assert.equal(ch.instagram_comments.median_ms, HOUR);
  assert.equal(ch.facebook.answered, 1, 'ответ в личку — тоже ответ');
  assert.equal(s.totals.comment_replies, 1);
  assert.equal(s.totals.private_replies, 1);
  assert.deepEqual(s.outside, { messages: 0, comment_replies: 1 }, 'ответ из Meta — без имени');

  assert.equal(s.totals.leads, 1);
  assert.equal(ch.facebook.leads, 1);
  assert.equal(s.leads.created, 1);
  assert.equal(s.totals.people, 5);
  assert.equal(s.totals.conversion, 0.2);
  assert.equal(s.stages.reduce((n, x) => n + x.count, 0), 1);

  const adm = s.staff.find((x) => x.user_id === 1);
  assert.deepEqual({ m: adm.messages, p: adm.private_replies, l: adm.leads, name: adm.name }, { m: 1, p: 1, l: 1, name: 'Администратор' });

  const inSeries = s.series.reduce((n, b) => n + b.messenger + b.instagram + b.facebook + b.instagram_comments, 0);
  assert.equal(inSeries, 8, 'график — все входящие периода');
  assert.equal(s.hours.reduce((n, x) => n + x.count, 0), 8);
  assert.equal(s.range.unit, 'day');
  assert.equal(s.series.length, 7);
  assert.equal(s.posts[0].post_id, 'p1', 'сверху — пост с большим числом комментариев');
  assert.equal(s.posts[0].comments, 2);
});

test('статистика: «Сегодня» — по часам; неизвестный период — 30 дней', () => {
  const db = fresh();
  const today = inboxStats(db, { days: 1, nowMs: NOW });
  assert.equal(today.range.unit, 'hour');
  assert.equal(today.series.length, 24);
  assert.equal(inboxStats(db, { days: 12345 }).range.days, 30);
  assert.equal(inboxStats(db, { days: 0 }).range.days, 0);
});

test('статистика: права — как у чтения переписки; RPC зарегистрирован', () => {
  const db = fresh();
  assert.throws(() => metaInboxStats(db, { days: 7 }, { id: 3, role: 'registrar' }), (e) => e.status === 403);
  assert.ok(metaInboxStats(db, { days: 7 }, { id: 1, role: 'admin' }).totals);
  assert.equal(typeof getRpc('meta_inbox_stats'), 'function');
});

// CRM_NO_SHOW_ANY_COLUMN_V1 (ревью F4) — лид в открытой колонке «Не пришёл» считается потерянным, не открытым.
test('CRM_NO_SHOW_ANY_COLUMN_V1: лид в открытой колонке «Не пришёл» — потерян, колонка в воронке — lost', () => {
  const db = fresh();
  db.prepare("INSERT INTO crm_stages (key,label,color,position,is_active,kind) VALUES ('missed','Не дошли','crit',4,1,'open')").run();
  db.prepare("UPDATE crm_stages SET role = NULL WHERE role = 'no_show'").run();
  db.prepare("UPDATE crm_stages SET role = 'no_show' WHERE key = 'missed'").run();
  const c2 = db.prepare("SELECT id FROM meta_comments WHERE comment_id = 'c2'").get().id;
  assert.equal(toCrm(db, { kind: 'comment', id: c2, userId: 1 }).ok, true);
  const rid = db.prepare('SELECT crm_request_id FROM meta_comments WHERE id = ?').get(c2).crm_request_id;
  db.prepare("UPDATE crm_requests SET status = 'missed' WHERE id = ?").run(rid);
  const s = inboxStats(db, { days: 7, nowMs: NOW });
  assert.equal(s.leads.lost, 1);
  assert.equal(s.leads.open, 0);
  assert.equal(s.stages.find((x) => x.key === 'missed').kind, 'lost');
});
