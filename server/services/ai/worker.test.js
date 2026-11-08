import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setAiEnabled, readAiSettings } from './settings.js';
import { enqueueChatJob, GIVE_UP_MS } from './queue.js';
import { isFlagged, flagChat } from './guards.js';
import { processOneJob, HANDOFF_TEXT, COMMENT_PUBLIC_TEXT } from './worker.js';

const T0 = Date.parse('2026-11-08T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function world(answer) {
  const db = openDb(':memory:'); migrate(db);
  setAiEnabled(db, true, 1, iso(T0));
  db.prepare(`INSERT INTO telegram_links (chat_id, phone, tg_user_id, tg_name, last_seen_at) VALUES ('100','+998901112233','u','Алишер',?)`).run(iso(T0));
  db.prepare("INSERT INTO telegram_messages (chat_id, direction, text, kind, tg_message_id) VALUES ('100','in','Сколько стоит УЗИ?','text','7')").run();
  enqueueChatJob(db, { channel: 'telegram', chatKey: '100', sourceId: '7', createdAt: iso(T0 + 1000), now: T0 + 2000 });
  const calls = { asked: [], tg: [], leads: [], dm: [], pub: [], priv: [], metaLeads: [] };
  const deps = {
    now: () => T0 + 3000,
    telegramToken: () => 'tok',
    ask: async (payload) => { calls.asked.push(payload); return typeof answer === 'function' ? answer() : answer; },
    sendTelegram: async (db2, token, chatId, text) => { calls.tg.push({ chatId, text }); return { ok: true }; },
    telegramLead: (db2, args) => { calls.leads.push(args); return { crm_request_id: 1 }; },
    facts: () => ({ services: [] }),
  };
  return { db, calls, deps };
}

test('ответ уходит в чат, задача закрыта, телефон связки наружу не ушёл', async () => {
  const { db, calls, deps } = world({ outcome: 'reply', text: 'УЗИ стоит 150 000 сум.' });
  assert.equal(await processOneJob(db, deps), 'done');
  assert.deepEqual(calls.tg, [{ chatId: '100', text: 'УЗИ стоит 150 000 сум.' }]);
  assert.ok(!JSON.stringify(calls.asked).includes('998901112233'));
  const j = db.prepare('SELECT status, outcome FROM ai_chat_jobs').get();
  assert.equal(j.status, 'done');
  assert.equal(j.outcome, 'reply');
});

test('заявка: CRM + ответ; телефон — из ответа ИИ или связки', async () => {
  const { db, calls, deps } = world({ outcome: 'create_lead', name: 'Алишер', phone: '', wish: 'УЗИ', text: 'Администратор свяжется с вами.' });
  await processOneJob(db, deps);
  assert.equal(calls.leads[0].phone, '+998901112233');
  assert.equal(calls.tg[0].text, 'Администратор свяжется с вами.');
});

test('передача оператору: текст, отметка, больше не отвечаем', async () => {
  const { db, calls, deps } = world({ outcome: 'hand_off', text: 'Сейчас подключу сотрудника клиники.', reason: 'medical' });
  assert.equal(await processOneJob(db, deps), 'handed_off');
  assert.equal(calls.tg[0].text, 'Сейчас подключу сотрудника клиники.');
  assert.equal(isFlagged(db, 'telegram', '100'), true);
});

test('передача оператору с пустым текстом — двуязычная фраза', async () => {
  const { db, calls, deps } = world({ outcome: 'hand_off', text: '' });
  assert.equal(await processOneJob(db, deps), 'handed_off');
  assert.equal(calls.tg[0].text, HANDOFF_TEXT);
});

test('отмеченный чат и недавний оператор — ни запроса, ни ответа', async () => {
  const { db, calls, deps } = world({ outcome: 'reply', text: 'x' });
  flagChat(db, 'telegram', '100', 'medical', T0);
  assert.equal(await processOneJob(db, deps), 'skipped');
  assert.equal(calls.asked.length, 0);
  assert.equal(calls.tg.length, 0);

  const op = world({ outcome: 'reply', text: 'x' });
  op.db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (5, 'op5', 'x', 'Оператор', 'admin')").run();
  op.db.prepare("INSERT INTO telegram_messages (chat_id, direction, text, kind, sent_by, created_at) VALUES ('100','out','Здравствуйте','text',5,?)").run(iso(T0));
  assert.equal(await processOneJob(op.db, op.deps), 'skipped');
  assert.equal(op.calls.asked.length, 0);
});

test('лимит: блокировка, отметка; сеть: повтор', async () => {
  const lim = world({ error: 'limit' });
  assert.equal(await processOneJob(lim.db, lim.deps), 'blocked');
  assert.equal(readAiSettings(lim.db).blocked, 'limit');
  assert.equal(isFlagged(lim.db, 'telegram', '100'), true);
  const net = world({ error: 'network' });
  assert.equal(await processOneJob(net.db, net.deps), 'retry');
  assert.equal(net.calls.tg.length, 0);
  assert.equal(net.db.prepare('SELECT status FROM ai_chat_jobs').get().status, 'queued');
});

test('сеть 10 минут — сдаёмся, чат оператору', async () => {
  const { db, calls, deps } = world({ error: 'network' });
  let t = T0 + 3000;
  deps.now = () => t;
  assert.equal(await processOneJob(db, deps), 'retry');
  // Задача снова ждёт; следующий шаг — уже после 10 минут, но expireStaleJobs
  // снимает её раньше запроса: чат отмечается 'timeout', ответа нет.
  t = T0 + 2000 + GIVE_UP_MS + 1000;
  assert.equal(await processOneJob(db, deps), 'idle');
  assert.equal(calls.asked.length, 1);
  assert.equal(calls.tg.length, 0);
  assert.equal(isFlagged(db, 'telegram', '100'), true);
});

test('выключили между постановкой и исполнением — задача снята', async () => {
  const { db, calls, deps } = world({ outcome: 'reply', text: 'x' });
  setAiEnabled(db, false, 1, iso(T0 + 2500));
  assert.equal(await processOneJob(db, deps), 'dropped');
  assert.equal(calls.asked.length, 0);
});

test('плохой ответ — передача оператору с двуязычным текстом', async () => {
  const { db, calls, deps } = world({ error: 'bad_response' });
  assert.equal(await processOneJob(db, deps), 'handed_off');
  assert.equal(calls.tg[0].text, HANDOFF_TEXT);
});

test('слишком большой запрос (413) — как плохой ответ: передача, без повтора', async () => {
  const { db, calls, deps } = world({ error: 'too_large' });
  assert.equal(await processOneJob(db, deps), 'handed_off');
  assert.equal(calls.tg[0].text, HANDOFF_TEXT);
  assert.equal(isFlagged(db, 'telegram', '100'), true);
  assert.equal(db.prepare('SELECT status FROM ai_chat_jobs').get().status, 'handed_off');
});

test('A3: ждущая задача старше 10 минут не отвечается, чат передан оператору', async () => {
  const { db, calls, deps } = world({ outcome: 'reply', text: 'x' });
  deps.now = () => T0 + 2000 + GIVE_UP_MS + 1000;
  assert.equal(await processOneJob(db, deps), 'idle');
  assert.equal(calls.asked.length, 0);
  assert.equal(calls.tg.length, 0);
  const j = db.prepare('SELECT status, outcome FROM ai_chat_jobs').get();
  assert.deepEqual({ ...j }, { status: 'failed', outcome: 'timeout' });
  assert.equal(isFlagged(db, 'telegram', '100'), true);
});

test('сбой отправки — задача закрыта, чат оператору', async () => {
  const { db, deps } = world({ outcome: 'reply', text: 'x' });
  deps.sendTelegram = async () => { throw new Error('Forbidden: bot was blocked'); };
  assert.equal(await processOneJob(db, deps), 'failed');
  assert.equal(isFlagged(db, 'telegram', '100'), true);
  assert.equal(db.prepare('SELECT outcome FROM ai_chat_jobs').get().outcome, 'send_failed');
});

// --- Facebook / Instagram ---------------------------------------------------

function metaWorld(answer) {
  const w = world(answer);
  const { db, calls, deps } = w;
  db.prepare('DELETE FROM ai_chat_jobs').run();
  deps.sendMetaDm = async (db2, convId, text) => {
    calls.dm.push({ convId, text });
    db2.prepare(`INSERT INTO meta_messages (conversation_id, direction, text, created_at) VALUES (?, 'out', ?, ?)`).run(Number(convId), text, iso(T0 + 3000));
    return { ok: true };
  };
  // Как replyToComment: ответ страницы ложится строкой нитки (root_id — корень).
  deps.replyComment = async (db2, id, text) => {
    calls.pub.push({ id, text });
    const c = db2.prepare('SELECT comment_id, root_id FROM meta_comments WHERE id = ?').get(Number(id));
    const key = c.root_id || c.comment_id;
    db2.prepare(`INSERT INTO meta_comments (platform, comment_id, parent_id, root_id, text, created_at, is_page)
                 VALUES ('facebook', ?, ?, ?, ?, ?, 1)`).run('page_' + calls.pub.length, key, key, text, iso(T0 + 3000));
    return { ok: true };
  };
  deps.privateReply = async (db2, id, text) => { calls.priv.push({ id, text }); return { ok: true }; };
  deps.metaLead = (db2, args) => { calls.metaLeads.push(args); return { ok: true }; };
  return w;
}

function seedThread(db) {
  const put = db.prepare(`INSERT INTO meta_comments (platform, comment_id, parent_id, root_id, author_name, text, created_at, post_text)
                          VALUES ('facebook', ?, ?, ?, ?, ?, ?, 'Акция на УЗИ')`);
  const rootId = Number(put.run('c1', '', '', 'Дилноза', 'Сколько стоит?', iso(T0 + 500)).lastInsertRowid);
  const replyId = Number(put.run('c2', 'c1', 'c1', 'Дилноза', 'А в субботу работаете?', iso(T0 + 1000)).lastInsertRowid);
  enqueueChatJob(db, { channel: 'meta_comment', chatKey: String(rootId), sourceId: 'c2', createdAt: iso(T0 + 1000), now: T0 + 2000 });
  return { rootId, replyId };
}

test('комментарий: публичный и личный ответ — на тот комментарий, что пришёл; ответ страницы помечен ИИ', async () => {
  const { db, calls, deps } = metaWorld({ outcome: 'reply_comment', public_text: 'Ответили вам в личных сообщениях.', private_text: 'Да, в субботу с 9 до 15.' });
  const { rootId, replyId } = seedThread(db);
  assert.equal(await processOneJob(db, deps), 'done');
  assert.deepEqual(calls.pub, [{ id: replyId, text: 'Ответили вам в личных сообщениях.' }]);
  assert.deepEqual(calls.priv, [{ id: replyId, text: 'Да, в субботу с 9 до 15.' }]);
  const page = db.prepare('SELECT by_ai FROM meta_comments WHERE is_page = 1').get();
  assert.equal(page.by_ai, 1);
  assert.equal(calls.asked[0].post_text, 'Акция на УЗИ');
  assert.equal(isFlagged(db, 'meta_comment', String(rootId)), false);
});

test('комментарий: заявка — на строку пришедшего комментария', async () => {
  const { db, calls, deps } = metaWorld({ outcome: 'create_lead', name: 'Дилноза', phone: '+998901234567', wish: 'УЗИ', text: 'Администратор свяжется с вами.' });
  const { replyId } = seedThread(db);
  assert.equal(await processOneJob(db, deps), 'done');
  assert.equal(calls.metaLeads[0].kind, 'comment');
  assert.equal(calls.metaLeads[0].id, replyId);
  assert.equal(calls.metaLeads[0].phone, '+998901234567');
});

test('комментарий: передача оператору — отметка на нитке', async () => {
  const { db, calls, deps } = metaWorld({ outcome: 'hand_off', text: '', reason: 'medical' });
  const { rootId, replyId } = seedThread(db);
  assert.equal(await processOneJob(db, deps), 'handed_off');
  assert.equal(calls.pub[0].id, replyId);
  assert.equal(calls.pub[0].text, COMMENT_PUBLIC_TEXT);
  assert.deepEqual(calls.priv, [{ id: replyId, text: HANDOFF_TEXT }]);
  assert.equal(isFlagged(db, 'meta_comment', String(rootId)), true);
});

test('комментарий удалён — задача снята без запроса', async () => {
  const { db, calls, deps } = metaWorld({ outcome: 'reply', text: 'x' });
  seedThread(db);
  db.prepare("DELETE FROM meta_comments WHERE comment_id = 'c2'").run();
  assert.equal(await processOneJob(db, deps), 'dropped');
  assert.equal(calls.asked.length, 0);
  assert.equal(db.prepare('SELECT outcome FROM ai_chat_jobs').get().outcome, 'gone');
});

test('личные сообщения Meta: ответ помечен ИИ; окно закрыто — передача без запроса', async () => {
  const { db, calls, deps } = metaWorld({ outcome: 'reply', text: 'Да, работаем.' });
  const conv = Number(db.prepare(`INSERT INTO meta_conversations (platform, conv_id, peer_id, peer_name, last_in_at) VALUES ('messenger','t1','p1','Азиз',?)`).run(iso(T0 + 1000)).lastInsertRowid);
  db.prepare(`INSERT INTO meta_messages (conversation_id, msg_id, direction, text, created_at) VALUES (?, 'm1', 'in', 'Работаете?', ?)`).run(conv, iso(T0 + 1000));
  enqueueChatJob(db, { channel: 'meta_dm', chatKey: String(conv), sourceId: 'm1', createdAt: iso(T0 + 1000), now: T0 + 2000 });
  assert.equal(await processOneJob(db, deps), 'done');
  assert.deepEqual(calls.dm, [{ convId: String(conv), text: 'Да, работаем.' }]);
  assert.equal(db.prepare("SELECT by_ai FROM meta_messages WHERE direction = 'out'").get().by_ai, 1);

  const closed = metaWorld({ outcome: 'reply', text: 'x' });
  const c2 = Number(closed.db.prepare(`INSERT INTO meta_conversations (platform, conv_id, peer_id, last_in_at) VALUES ('messenger','t2','p2',?)`).run(iso(T0 - 25 * 3600_000)).lastInsertRowid);
  enqueueChatJob(closed.db, { channel: 'meta_dm', chatKey: String(c2), sourceId: 'm2', createdAt: iso(T0 + 1000), now: T0 + 2000 });
  assert.equal(await processOneJob(closed.db, closed.deps), 'handed_off');
  assert.equal(closed.calls.asked.length, 0);
  assert.equal(closed.calls.dm.length, 0);
  assert.equal(isFlagged(closed.db, 'meta_dm', String(c2)), true);
});

// --- После ревью: публичный текст, повторная проверка, недостижимый чат ------

test('комментарий: заявка — публично только короткая фраза, телефон не виден всем', async () => {
  const { db, calls, deps } = metaWorld({ outcome: 'create_lead', name: 'Дилноза', phone: '+998901234567', wish: 'УЗИ',
    text: 'Записали ваш номер +998901234567, администратор позвонит.' });
  const { replyId } = seedThread(db);
  assert.equal(await processOneJob(db, deps), 'done');
  assert.deepEqual(calls.pub, [{ id: replyId, text: COMMENT_PUBLIC_TEXT }]);
  assert.ok(!JSON.stringify(calls.pub).includes('998901234567'));
  assert.equal(calls.priv[0].text, 'Записали ваш номер +998901234567, администратор позвонит.');
});

test('комментарий: reply и reply_comment с пустым public_text — публично короткая фраза', async () => {
  const a = metaWorld({ outcome: 'reply', text: 'Да, в субботу с 9 до 15.' });
  seedThread(a.db);
  assert.equal(await processOneJob(a.db, a.deps), 'done');
  assert.equal(a.calls.pub[0].text, COMMENT_PUBLIC_TEXT);
  assert.equal(a.calls.priv[0].text, 'Да, в субботу с 9 до 15.');
  const b = metaWorld({ outcome: 'reply_comment', public_text: '', private_text: 'Да.' });
  seedThread(b.db);
  assert.equal(await processOneJob(b.db, b.deps), 'done');
  assert.equal(b.calls.pub[0].text, COMMENT_PUBLIC_TEXT);
});

test('оператор написал, пока ИИ думал — ничего не отправлено', async () => {
  const w = world(null);
  w.db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (5, 'op5', 'x', 'Оператор', 'admin')").run();
  w.deps.ask = async () => {
    w.db.prepare("INSERT INTO telegram_messages (chat_id, direction, text, kind, sent_by, created_at) VALUES ('100','out','Здравствуйте','text',5,?)").run(iso(T0 + 3500));
    return { outcome: 'reply', text: 'x' };
  };
  assert.equal(await processOneJob(w.db, w.deps), 'skipped');
  assert.equal(w.calls.tg.length, 0);
  assert.deepEqual({ ...w.db.prepare('SELECT status, outcome FROM ai_chat_jobs').get() }, { status: 'dropped', outcome: 'operator' });
});

test('выключили, пока ИИ думал — ничего не отправлено, заявки нет', async () => {
  const w = world(null);
  w.deps.ask = async () => { setAiEnabled(w.db, false, 1, iso(T0 + 3500)); return { outcome: 'create_lead', name: 'A', phone: '', wish: 'x', text: 'x' }; };
  assert.equal(await processOneJob(w.db, w.deps), 'dropped');
  assert.equal(w.calls.tg.length, 0);
  assert.equal(w.calls.leads.length, 0);
  assert.equal(w.db.prepare('SELECT outcome FROM ai_chat_jobs').get().outcome, 'switch_off');
});

test('время после запроса — свежее: задача закрыта временем ответа', async () => {
  const w = world({ outcome: 'reply', text: 'x' });
  let t = T0 + 3000;
  w.deps.now = () => t;
  const ask = w.deps.ask;
  w.deps.ask = async (p) => { t = T0 + 40_000; return ask(p); };
  assert.equal(await processOneJob(w.db, w.deps), 'done');
  assert.equal(w.db.prepare('SELECT finished_at FROM ai_chat_jobs').get().finished_at, iso(T0 + 40_000));
});

test('ошибка чтения базы до отправки — задача не висит в working', async () => {
  const w = world({ outcome: 'reply', text: 'x' });
  w.deps.facts = () => { throw new Error('SQLITE_BUSY'); };
  assert.equal(await processOneJob(w.db, w.deps), 'failed');
  assert.equal(w.db.prepare('SELECT status FROM ai_chat_jobs').get().status, 'failed');
  assert.equal(w.calls.tg.length, 0);
});

test('Telegram недостижим (нет токена, чат отвязан, бот заблокирован) — без платного запроса и без отметки', async () => {
  const cases = [
    (w) => { w.deps.telegramToken = () => ''; },
    (w) => { w.db.prepare("UPDATE telegram_links SET revoked_at = ? WHERE chat_id = '100'").run(iso(T0)); },
    (w) => { w.db.prepare("UPDATE telegram_links SET blocked_at = ? WHERE chat_id = '100'").run(iso(T0)); },
  ];
  for (const setup of cases) {
    const w = world({ outcome: 'reply', text: 'x' });
    setup(w);
    assert.equal(await processOneJob(w.db, w.deps), 'dropped');
    assert.equal(w.calls.asked.length, 0);
    assert.equal(w.db.prepare('SELECT outcome FROM ai_chat_jobs').get().outcome, 'unreachable');
    assert.equal(isFlagged(w.db, 'telegram', '100'), false);
  }
});

test('Meta: длинный текст режется до 2000 знаков', async () => {
  const long = 'а'.repeat(3000);
  const { db, calls, deps } = metaWorld({ outcome: 'reply', text: long });
  const conv = Number(db.prepare(`INSERT INTO meta_conversations (platform, conv_id, peer_id, last_in_at) VALUES ('messenger','t1','p1',?)`).run(iso(T0 + 1000)).lastInsertRowid);
  enqueueChatJob(db, { channel: 'meta_dm', chatKey: String(conv), sourceId: 'm1', createdAt: iso(T0 + 1000), now: T0 + 2000 });
  assert.equal(await processOneJob(db, deps), 'done');
  assert.equal(calls.dm[0].text.length, 2000);
  assert.equal(db.prepare("SELECT by_ai FROM meta_messages WHERE direction = 'out'").get().by_ai, 1);

  const c = metaWorld({ outcome: 'reply_comment', public_text: 'б'.repeat(2500), private_text: long });
  seedThread(c.db);
  assert.equal(await processOneJob(c.db, c.deps), 'done');
  assert.equal(c.calls.pub[0].text.length, 2000);
  assert.equal(c.calls.priv[0].text.length, 2000);
  assert.equal(c.db.prepare('SELECT by_ai FROM meta_comments WHERE is_page = 1').get().by_ai, 1);
});

test('Meta: нераспознанный номер — заявка без номера, но сырой номер в комментарии CRM', async () => {
  const { db, calls, deps } = metaWorld({ outcome: 'create_lead', name: 'Дилноза', phone: '12-34', wish: 'УЗИ', text: 'Администратор свяжется.' });
  deps.metaLead = (db2, args) => { calls.metaLeads.push(args); return args.phone ? { ok: false, reason: 'bad_phone' } : { ok: true }; };
  seedThread(db);
  assert.equal(await processOneJob(db, deps), 'done');
  assert.equal(calls.metaLeads.length, 2);
  assert.equal(calls.metaLeads[1].phone, '');
  assert.equal(calls.metaLeads[1].comment, 'Создано ИИ: УЗИ\nТелефон (не распознан): 12-34');
});

test('комментарий: личный ответ не ушёл — публично ничего, задача не удалась, нитка оператору', async () => {
  const { db, calls, deps } = metaWorld({ outcome: 'reply', text: 'Да, в субботу с 9 до 15.' });
  deps.privateReply = async (db2, id, text) => { calls.priv.push({ id, text }); return { ok: false, reason: 'already_replied' }; };
  const { rootId } = seedThread(db);
  assert.equal(await processOneJob(db, deps), 'failed');
  assert.equal(calls.priv.length, 1);
  assert.equal(calls.pub.length, 0);
  assert.equal(db.prepare('SELECT outcome FROM ai_chat_jobs').get().outcome, 'send_failed');
  assert.equal(isFlagged(db, 'meta_comment', String(rootId)), true);
});
