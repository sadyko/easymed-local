// META_INBOX_V1 — «Чат Facebook и Instagram»: опрос, ответы, права.
//
// Graph API — подделкой fetch по пути запроса; сеть не трогается. Что закреплено:
//   * опрос раскладывает Messenger, Direct, комментарии Facebook (посты и
//     реклама) и Instagram по своим таблицам; повтор ничего не плодит;
//   * история старше включения приходит прочитанной;
//   * ответ — POST /{page}/messages токеном страницы; окно 24 часа
//     проверяется до запроса; отказ Meta — строка «не доставлено», не 500;
//   * ответ на комментарий — в корень нитки; в личку — один раз;
//   * права: без раздела — 403, «Просмотр» читает, но не отвечает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { storeConnection } from './settings.js';
import { setInboxEnabled, readInboxState, listConversations, listCommentThreads, unreadCounts } from './inbox-store.js';
import { pollInboxOnce } from './inbox-poller.js';
import {
  metaInboxState, metaInboxToggle, metaInboxConversations, metaInboxMessages, metaInboxSend,
  metaInboxComments, metaInboxCommentThread, metaInboxCommentReply, metaInboxCommentPrivate,
  metaInboxCommentHide, metaInboxToCrm,
} from '../rpc/meta-inbox.js';
import { getRpc } from '../rpc/index.js';

const PAGE = '1001', IG = '17841';
const PAGE_TOKEN = 'page-test-only-token-555';
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, '+0000');

const admin = { id: 1, role: 'admin' };
const viewer = { id: 2, role: 'smm' };
const registrar = { id: 3, role: 'registrar' };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin', 'Администратор');
  ins.run(2, 'smm', 'x', 'smm', 'СММ');
  ins.run(3, 'reg', 'x', 'registrar', 'Регистратор');
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
    .run('smm', JSON.stringify({ sections: ['meta-chat'], levels: { 'meta-chat': 'viewer' } }));
  return db;
}

/** Ответы Graph по пути; calls — что спросили (метод, путь, тело). */
function fakeGraph(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/v[\d.]+\//, '');
    const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    calls.push({ method: init.method || 'GET', path: p, query: Object.fromEntries(u.searchParams), body });
    const key = `${init.method || 'GET'} ${p}`;
    const r = typeof routes[key] === 'function' ? routes[key]({ body, query: Object.fromEntries(u.searchParams) }) : routes[key];
    const res = r === undefined ? { error: { code: 100, message: 'unknown path ' + key } } : r;
    return { ok: !res.error, status: res.error ? 400 : 200, text: async () => JSON.stringify(res) };
  };
  return { fetchImpl, calls };
}

const conv = (id, peer, msgs, updated = iso(0)) => ({
  id, updated_time: updated,
  participants: { data: [{ id: PAGE, name: 'Клиника' }, peer] },
  messages: { data: msgs },
});

function inboxRoutes(over = {}) {
  return {
    [`GET ${PAGE}`]: { id: PAGE, instagram_business_account: { id: IG, username: 'clinic.uz' } },
    [`GET ${PAGE}/conversations`]: ({ query }) => (query.platform === 'messenger'
      ? { data: [conv('t_m1', { id: 'psid1', name: 'Анна Ким' }, [
          { id: 'm_2', created_time: iso(60_000), from: { id: PAGE }, message: 'Здравствуйте! Чем помочь?' },
          { id: 'm_1', created_time: iso(120_000), from: { id: 'psid1' }, message: 'Сколько стоит УЗИ?' },
        ])] }
      : { data: [conv('t_i1', { id: 'igsid1', username: 'bek_92' }, [
          { id: 'mi_1', created_time: iso(30_000), from: { id: 'igsid1', username: 'bek_92' }, message: 'Есть запись на завтра?' },
        ])] }),
    [`GET ${PAGE}/feed`]: { data: [{
      id: `${PAGE}_p1`, message: 'Скидка на анализы', permalink_url: 'https://fb.example/p1', created_time: iso(86_400_000),
      comments: { data: [
        { id: 'c_2', message: 'Спасибо!', from: { id: PAGE, name: 'Клиника' }, created_time: iso(10_000), parent: { id: 'c_1' } },
        { id: 'c_1', message: 'А в субботу работаете?', from: { id: 'u1', name: 'Олег' }, created_time: iso(20_000) },
      ] },
    }] },
    [`GET ${PAGE}/ads_posts`]: { data: [{
      id: `${PAGE}_ad1`, message: 'Чек-ап 2026', permalink_url: 'https://fb.example/ad1', created_time: iso(86_400_000),
      comments: { data: [{ id: 'c_ad', message: 'Цена?', from: { id: 'u2', name: 'Дилноза' }, created_time: iso(5_000) }] },
    }] },
    [`GET ${IG}/media`]: { data: [{
      id: 'med1', caption: 'Новый аппарат МРТ', permalink: 'https://ig.example/med1', timestamp: iso(86_400_000),
      comments: { data: [{ id: 'ic_1', text: 'Где вы находитесь?', username: 'aziz', timestamp: iso(15_000), from: { id: 'igu1', username: 'aziz' },
        replies: { data: [{ id: 'ic_2', text: 'Чиланзар, 5', username: 'clinic.uz', timestamp: iso(14_000), from: { id: IG, username: 'clinic.uz' } }] } }] },
    }] },
    ...over,
  };
}

function connected(routes) {
  const db = fresh();
  const kekPath = path.join(tmpDir('em-meta-inbox-'), '.api-secrets-key');
  storeConnection(db, { token: 'user-test-only-token-111', pageToken: PAGE_TOKEN, page: { id: PAGE, name: 'Клиника' } }, { kekPath });
  setInboxEnabled(db, true, 1);
  // Включили «давно»: всё, что ниже, — новое, а не история.
  db.prepare("UPDATE meta_inbox_state SET enabled_at = '2000-01-01T00:00:00Z'").run();
  const g = fakeGraph(routes || inboxRoutes());
  return { db, deps: { kekPath, fetchImpl: g.fetchImpl, hasModule: () => true }, calls: g.calls };
}

test('опрос: Messenger, Direct, комментарии Facebook (пост и реклама) и Instagram — по местам; повтор ничего не плодит', async () => {
  const { db, deps, calls } = connected();
  await pollInboxOnce(db, deps);
  const convs = listConversations(db);
  assert.deepStrictEqual(convs.map((c) => [c.platform, c.peer_name || c.peer_username, c.unread]).sort(),
    [['instagram', 'bek_92', 1], ['messenger', 'Анна Ким', 1]]);
  const m = convs.find((c) => c.platform === 'messenger');
  assert.equal(m.last_text, 'Здравствуйте! Чем помочь?');
  assert.equal(m.last_direction, 'out', 'сообщение страницы — исходящее');

  const threads = listCommentThreads(db);
  const fb = threads.find((t) => t.text === 'А в субботу работаете?');
  assert.ok(fb, 'нитка Facebook');
  assert.equal(fb.replies, 1, 'ответ клиники — в нитке');
  assert.equal(fb.answered, true);
  assert.ok(threads.find((t) => t.post_is_ad && t.text === 'Цена?'), 'комментарий под рекламой');
  const ig = threads.find((t) => t.platform === 'instagram');
  assert.equal(ig.text, 'Где вы находитесь?');
  assert.equal(ig.answered, true, 'ответ аккаунта клиники распознан');
  assert.deepStrictEqual(unreadCounts(db), { messenger: 1, instagram: 1, comments: 3, total: 5 });

  assert.ok(calls.every((c) => c.query.access_token === PAGE_TOKEN), 'читаем токеном страницы');
  const st = readInboxState(db);
  assert.equal(st.ig_username, 'clinic.uz');
  assert.deepStrictEqual(st.errors, {});

  await pollInboxOnce(db, deps);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meta_messages').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meta_comments').get().n, 5);
});

test('опрос: история старше включения — прочитана; нет права на рекламу — слово ads_no_permission, остальное приходит', async () => {
  const { db, deps } = connected(inboxRoutes({ [`GET ${PAGE}/ads_posts`]: { error: { code: 200, message: 'pages_manage_ads' } } }));
  db.prepare("UPDATE meta_inbox_state SET enabled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')").run();
  await pollInboxOnce(db, deps);
  assert.equal(unreadCounts(db).total, 0, 'всё старше включения');
  assert.equal(readInboxState(db).errors.facebook, 'ads_no_permission');
  assert.ok(listCommentThreads(db).length >= 2, 'обычные посты пришли');
});

test('опрос: недействительный токен выключает опрос', async () => {
  const { db, deps } = connected(inboxRoutes({ [`GET ${PAGE}`]: { error: { code: 190, message: 'expired' } } }));
  await pollInboxOnce(db, deps);
  assert.equal(readInboxState(db).enabled, false);
  assert.equal(readInboxState(db).errors.ig, 'bad_token');
});

test('ответ в переписке: POST /{page}/messages токеном страницы; окно 24 часа — до запроса; отказ — строка «не доставлено»', async () => {
  let fail = false;
  const { db, deps, calls } = connected(inboxRoutes({
    [`POST ${PAGE}/messages`]: () => (fail ? { error: { code: 551, message: 'unavailable' } } : { recipient_id: 'psid1', message_id: 'm_out1' }),
  }));
  await pollInboxOnce(db, deps);
  const m = listConversations(db).find((c) => c.platform === 'messenger');

  const ok = await metaInboxSend(db, { id: m.id, text: 'Стоит 150 000 сум.' }, admin, deps);
  assert.equal(ok.ok, true);
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.path, `${PAGE}/messages`);
  assert.equal(post.body.access_token, PAGE_TOKEN);
  assert.deepStrictEqual(JSON.parse(post.body.recipient), { id: 'psid1' });
  assert.deepStrictEqual(JSON.parse(post.body.message), { text: 'Стоит 150 000 сум.' });
  assert.equal(post.query.access_token, undefined, 'токен — в теле, не в адресе');

  fail = true;
  const bad = await metaInboxSend(db, { id: m.id, text: 'Ещё вопрос?' }, admin, deps);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'user_unavailable');
  assert.ok(bad.message.length > 10);
  const thread = metaInboxMessages(db, { id: m.id }, admin);
  assert.deepStrictEqual(thread.messages.slice(-2).map((x) => [x.text, x.status]), [['Стоит 150 000 сум.', 'ok'], ['Ещё вопрос?', 'failed']]);
  assert.equal(thread.messages.at(-2).sent_by_name, 'Администратор');

  // Окно закрыто: последнее входящее — два дня назад. В Meta не ходим.
  db.prepare("UPDATE meta_conversations SET last_in_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(m.id);
  const before = calls.length;
  const late = await metaInboxSend(db, { id: m.id, text: 'Здравствуйте' }, admin, deps);
  assert.equal(late.reason, 'window_closed');
  assert.equal(calls.length, before);
});

test('комментарии: ответ — в корень нитки (Facebook /comments, Instagram /replies); в личку — один раз; скрыть — is_hidden / hide', async () => {
  const { db, deps, calls } = connected(inboxRoutes({
    'POST c_1/comments': { id: 'c_3' },
    'POST ic_1/replies': { id: 'ic_3' },
    [`POST ${PAGE}/messages`]: { recipient_id: 'u1', message_id: 'm_pr' },
    'POST c_1': { success: true },
    'POST ic_1': { success: true },
  }));
  await pollInboxOnce(db, deps);
  const ids = Object.fromEntries(db.prepare('SELECT comment_id, id FROM meta_comments').all().map((r) => [r.comment_id, r.id]));

  // ответ на ОТВЕТ клиники всё равно уходит в корень c_1
  assert.equal((await metaInboxCommentReply(db, { id: ids.c_2, text: 'Да, до 15:00' }, admin, deps)).ok, true);
  assert.equal(calls.at(-1).path, 'c_1/comments');
  assert.equal((await metaInboxCommentReply(db, { id: ids.ic_1, text: 'Ждём вас' }, admin, deps)).ok, true);
  assert.equal(calls.at(-1).path, 'ic_1/replies');
  const t = metaInboxCommentThread(db, { id: ids.c_1 }, admin);
  assert.deepStrictEqual(t.comments.map((c) => [c.text, c.is_page]), [['А в субботу работаете?', false], ['Спасибо!', true], ['Да, до 15:00', true]]);

  assert.equal((await metaInboxCommentPrivate(db, { id: ids.c_1, text: 'Напишите номер, перезвоним' }, admin, deps)).ok, true);
  assert.deepStrictEqual(JSON.parse(calls.at(-1).body.recipient), { comment_id: 'c_1' });
  const again = await metaInboxCommentPrivate(db, { id: ids.c_1, text: 'ещё раз' }, admin, deps);
  assert.equal(again.reason, 'already_replied');

  assert.equal((await metaInboxCommentHide(db, { id: ids.c_1, hidden: true }, admin, deps)).ok, true);
  assert.equal(calls.at(-1).body.is_hidden, 'true');
  assert.equal((await metaInboxCommentHide(db, { id: ids.ic_1, hidden: true }, admin, deps)).ok, true);
  assert.equal(calls.at(-1).body.hide, 'true');
  assert.equal(metaInboxComments(db, {}, admin).threads.find((x) => x.id === ids.c_1).is_hidden, true);
});

test('В CRM: карточка с источником Meta; повтор возвращает ту же; кривой номер — отказ', async () => {
  const { db, deps } = connected();
  await pollInboxOnce(db, deps);
  const m = listConversations(db).find((c) => c.platform === 'messenger');
  assert.equal(metaInboxToCrm(db, { kind: 'conversation', id: m.id, phone: '12' }, admin).reason, 'bad_phone');
  const r = metaInboxToCrm(db, { kind: 'conversation', id: m.id, phone: '+998 90 123 45 67' }, admin);
  assert.equal(r.status, 'created');
  const card = db.prepare('SELECT full_name, phone, source, note FROM crm_requests WHERE id = ?').get(r.crm_request_id);
  assert.equal(card.full_name, 'Анна Ким');
  assert.equal(card.source, 'meta_ads');
  assert.match(card.note, /Messenger/);
  assert.match(card.note, /Сколько стоит УЗИ\?/);
  assert.equal(metaInboxToCrm(db, { kind: 'conversation', id: m.id }, admin).status, 'exists');

  const c = db.prepare("SELECT id FROM meta_comments WHERE comment_id = 'c_ad'").get();
  const rc = metaInboxToCrm(db, { kind: 'comment', id: c.id }, admin);
  assert.match(db.prepare('SELECT note FROM crm_requests WHERE id = ?').get(rc.crm_request_id).note, /рекламе Facebook/);
});

test('права: без раздела — 403; «Просмотр» читает, но не отвечает и не включает опрос; администратор — всё', async () => {
  const { db, deps } = connected();
  await pollInboxOnce(db, deps);
  assert.throws(() => metaInboxConversations(db, {}, registrar), (e) => e.status === 403);
  assert.equal(metaInboxConversations(db, {}, viewer).conversations.length, 2);
  const st = metaInboxState(db, {}, viewer);
  assert.equal(st.can_reply, false);
  assert.equal(st.can_manage, false);
  await assert.rejects(metaInboxSend(db, { id: 1, text: 'x' }, viewer, deps), (e) => e.status === 403);
  assert.throws(() => metaInboxToggle(db, { enabled: false }, viewer), (e) => e.status === 403);
  assert.equal(metaInboxState(db, {}, admin).can_manage, true);
  assert.equal(metaInboxToggle(db, { enabled: false }, admin).enabled, false);
});

test('без подключения Meta включить нельзя; RPC зарегистрированы', () => {
  const db = fresh();
  assert.throws(() => metaInboxToggle(db, { enabled: true }, admin), (e) => e.status === 409);
  for (const n of ['meta_inbox_state', 'meta_inbox_toggle', 'meta_inbox_send', 'meta_inbox_comment_reply', 'meta_inbox_to_crm', 'meta_inbox_unread']) {
    assert.equal(typeof getRpc(n), 'function', n);
  }
});

// META_INBOX_LEAD_FORM_V1 — форма «Лид в CRM»: имя сотрудника вместо имени в
// Meta, комментарий дописан к записи, «Ответственный — я» — только новой карточке.
test('В CRM из формы: имя, комментарий сотрудника и ответственный', async () => {
  const { db, deps } = connected();
  await pollInboxOnce(db, deps);
  const m = listConversations(db).find((c) => c.platform === 'messenger');
  const r = metaInboxToCrm(db, { kind: 'conversation', id: m.id, name: '  Анна Ким (мама)  ', comment: 'Хочет УЗИ в субботу', take: true }, admin);
  assert.equal(r.status, 'created');
  const card = db.prepare('SELECT full_name, note, assigned_to, created_by FROM crm_requests WHERE id = ?').get(r.crm_request_id);
  assert.equal(card.full_name, 'Анна Ким (мама)');
  assert.match(card.note, /Сколько стоит УЗИ\?/);
  assert.match(card.note, /Комментарий сотрудника: Хочет УЗИ в субботу/);
  assert.equal(card.assigned_to, admin.id);
  assert.equal(card.created_by, admin.id);

  // Без галочки ответственного нет; ответ в нитке — свой лид, отдельно от корня.
  const c = db.prepare("SELECT id FROM meta_comments WHERE comment_id = 'c_ad'").get();
  const rc = metaInboxToCrm(db, { kind: 'comment', id: c.id }, admin);
  assert.equal(db.prepare('SELECT assigned_to FROM crm_requests WHERE id = ?').get(rc.crm_request_id).assigned_to, null);
});
