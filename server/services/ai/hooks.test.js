import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setAiEnabled } from './settings.js';
import { aiTakesTelegramText, aiNoteMetaMessage, aiNoteMetaComment, aiNoteMetaCommentById } from './hooks.js';
import { claimNextJob } from './queue.js';
import { flagChat } from './guards.js';
import { handleUpdate } from '../telegram/flow.js';
import { upsertComment } from '../meta/inbox-store.js';

const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function linked() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare(`INSERT INTO telegram_links (chat_id, phone, tg_user_id, tg_name, last_seen_at) VALUES ('100','+998901112233','100','A',?)`).run(iso());
  return db;
}
function harness() {
  const sent = [];
  return { sent, deps: { fetchImpl: async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }; } } };
}
const textMsg = (text, id = 7) => ({ message: { chat: { id: 100 }, from: { id: 100 }, message_id: id, text } });

test('ИИ выключен — бот отвечает «сообщение получено», очереди нет', async () => {
  const db = linked(); const { sent, deps } = harness();
  await handleUpdate(db, 'x', textMsg('Сколько стоит УЗИ?'), deps);
  assert.equal(sent.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_chat_jobs').get().n, 0);
});

test('ИИ включён — задача в очереди, бот не отвечает сам', async () => {
  const db = linked(); const { sent, deps } = harness();
  setAiEnabled(db, true, 1, '2020-01-01T00:00:00Z');
  await handleUpdate(db, 'x', textMsg('Сколько стоит УЗИ?'), deps);
  assert.equal(sent.length, 0);
  assert.deepEqual({ ...db.prepare('SELECT channel, chat_key, source_id FROM ai_chat_jobs').get() },
    { channel: 'telegram', chat_key: '100', source_id: '100:7' });
});

test('кнопки и команды бота ИИ не забирает', async () => {
  const db = linked(); const { sent, deps } = harness();
  setAiEnabled(db, true, 1, '2020-01-01T00:00:00Z');
  await handleUpdate(db, 'x', textMsg('/start', 8), deps);
  await handleUpdate(db, 'x', textMsg('/help', 9), deps);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_chat_jobs').get().n, 0);
  assert.equal(sent.length, 2, 'на команды бот отвечает как раньше');
});

test('ИИ включён, но чат не привязан — приветствие с кнопкой контакта, очереди нет', async () => {
  const db = openDb(':memory:'); migrate(db); const { sent, deps } = harness();
  setAiEnabled(db, true, 1, '2020-01-01T00:00:00Z');
  await handleUpdate(db, 'x', textMsg('Здравствуйте'), deps);
  assert.equal(sent.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_chat_jobs').get().n, 0);
});

test('Meta: входящее сообщение и чужой комментарий ставятся, свои — нет', () => {
  const db = openDb(':memory:'); migrate(db);
  setAiEnabled(db, true, 1, '2020-01-01T00:00:00Z');
  assert.equal(aiNoteMetaMessage(db, { convRowId: 5, msgId: 'm1', direction: 'in', createdAt: iso() }), 'queued');
  assert.equal(aiNoteMetaMessage(db, { convRowId: 5, msgId: 'm2', direction: 'out', createdAt: iso() }), 'skip');
  assert.equal(aiNoteMetaComment(db, { threadRowId: 9, commentId: 'k1', isPage: false, createdAt: iso() }), 'queued');
  assert.equal(aiNoteMetaComment(db, { threadRowId: 10, commentId: 'k2', isPage: true, createdAt: iso() }), 'skip');
  assert.equal(aiTakesTelegramText(db, { chatId: '1', messageId: '', createdAt: iso() }), false, 'без id сообщения — не ставим');
});

test('Meta: ИИ выключен — комментарий не ставится', () => {
  const db = openDb(':memory:'); migrate(db);
  assert.equal(aiNoteMetaComment(db, { threadRowId: 9, commentId: 'k1', isPage: false, createdAt: iso() }), 'off');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_chat_jobs').get().n, 0);
});

test('A2: два комментария одной нитки — один chat_key (строка корня), второй сливается при взятии', () => {
  const db = openDb(':memory:'); migrate(db);
  setAiEnabled(db, true, 1, '2020-01-01T00:00:00Z');
  const base = { platform: 'facebook', post_id: 'p1', author_id: 'u1', author_name: 'Пациент', is_page: false };
  upsertComment(db, { ...base, comment_id: 'c1', text: 'Цена?', created_at: iso() });
  upsertComment(db, { ...base, comment_id: 'c2', parent_id: 'c1', text: 'И адрес?', created_at: iso() });
  upsertComment(db, { ...base, comment_id: 'c3', parent_id: 'c2', text: 'Ау', created_at: iso() });
  assert.equal(aiNoteMetaCommentById(db, 'c1'), 'queued');
  assert.equal(aiNoteMetaCommentById(db, 'c3'), 'queued');
  assert.equal(aiNoteMetaCommentById(db, 'c3'), 'dup', 'повторный опрос безвреден');
  const rootRow = db.prepare(`SELECT id FROM meta_comments WHERE comment_id = 'c1'`).get().id;
  const jobs = db.prepare('SELECT chat_key, source_id FROM ai_chat_jobs ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(jobs, [{ chat_key: String(rootRow), source_id: 'c1' }, { chat_key: String(rootRow), source_id: 'c3' }]);
  claimNextJob(db);
  assert.equal(db.prepare(`SELECT status FROM ai_chat_jobs WHERE source_id = 'c3'`).get().status, 'merged');
});

test('A2: ответ страницы и неизвестный комментарий не ставятся', () => {
  const db = openDb(':memory:'); migrate(db);
  setAiEnabled(db, true, 1, '2020-01-01T00:00:00Z');
  upsertComment(db, { platform: 'facebook', comment_id: 'pg', post_id: 'p1', author_id: 'page', text: 'Спасибо', created_at: iso(), is_page: true });
  assert.equal(aiNoteMetaCommentById(db, 'pg'), 'skip');
  assert.equal(aiNoteMetaCommentById(db, 'nope'), 'skip');
});

// --- после ревью Task 12 ---

function twoLinked() {
  const db = linked();
  db.prepare(`INSERT INTO telegram_links (chat_id, phone, tg_user_id, tg_name, last_seen_at) VALUES ('200','+998901112244','200','B',?)`).run(iso());
  return db;
}

test('message_id у Telegram свой в каждом чате — одинаковый id у двух пациентов даёт две задачи', async () => {
  const db = twoLinked(); const { sent, deps } = harness();
  setAiEnabled(db, true, 1, '2020-01-01T00:00:00Z');
  await handleUpdate(db, 'x', textMsg('Сколько стоит УЗИ?', 7), deps);
  await handleUpdate(db, 'x', { message: { chat: { id: 200 }, from: { id: 200 }, message_id: 7, text: 'А анализ крови?' } }, deps);
  assert.equal(sent.length, 0, 'оба взял ИИ');
  const jobs = db.prepare('SELECT chat_key, source_id, status FROM ai_chat_jobs ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(jobs, [
    { chat_key: '100', source_id: '100:7', status: 'queued' },
    { chat_key: '200', source_id: '200:7', status: 'queued' },
  ]);
  // Взятие первой задачи не сливает чужой чат.
  assert.equal(claimNextJob(db).chat_key, '100');
  assert.equal(db.prepare(`SELECT status FROM ai_chat_jobs WHERE chat_key = '200'`).get().status, 'queued');
});

test('пациент заблокировал бота — ИИ не берёт, бот ведёт себя как раньше', async () => {
  const db = linked(); const { sent, deps } = harness();
  setAiEnabled(db, true, 1, '2020-01-01T00:00:00Z');
  db.prepare(`UPDATE telegram_links SET blocked_at = ? WHERE chat_id = '100'`).run(iso());
  await handleUpdate(db, 'x', textMsg('Сколько стоит УЗИ?'), deps);
  assert.equal(sent.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_chat_jobs').get().n, 0);
});

test('оператор недавно писал в чат — ИИ не берёт, «сообщение получено» как раньше', async () => {
  const db = linked(); const { sent, deps } = harness();
  setAiEnabled(db, true, 1, '2020-01-01T00:00:00Z');
  const uid = db.prepare(`INSERT INTO users (username, password_hash) VALUES ('op', 'x')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO telegram_messages (chat_id, direction, text, kind, sent_by, created_at) VALUES ('100','out','Здравствуйте','text',?,?)`).run(uid, iso());
  await handleUpdate(db, 'x', textMsg('Сколько стоит УЗИ?'), deps);
  assert.equal(sent.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_chat_jobs').get().n, 0);
});

test('чат отмечен «нужен оператор» — ИИ не берёт, «сообщение получено» как раньше', async () => {
  const db = linked(); const { sent, deps } = harness();
  setAiEnabled(db, true, 1, '2020-01-01T00:00:00Z');
  flagChat(db, 'telegram', '100', 'hand_off');
  await handleUpdate(db, 'x', textMsg('Сколько стоит УЗИ?'), deps);
  assert.equal(sent.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_chat_jobs').get().n, 0);
});

test('комментарий: ИИ выключен — off без поиска; скрытый комментарий — skip', () => {
  const db = openDb(':memory:'); migrate(db);
  const base = { platform: 'facebook', post_id: 'p1', author_id: 'u1', is_page: false, created_at: iso() };
  upsertComment(db, { ...base, comment_id: 'h1', text: 'спам', is_hidden: true });
  upsertComment(db, { ...base, comment_id: 'v1', text: 'Цена?' });
  assert.equal(aiNoteMetaCommentById(db, 'v1'), 'off');
  setAiEnabled(db, true, 1, '2020-01-01T00:00:00Z');
  assert.equal(aiNoteMetaCommentById(db, 'h1'), 'skip');
  assert.equal(aiNoteMetaCommentById(db, 'v1'), 'queued');
});

// AI_CHAT_V1: ИИ берёт только то, что поставил в очередь. Повтор того же
// сообщения ('dup') и старое ('old') задачи не создают — ответить на них
// некому, поэтому бот подтверждает «сообщение получено», как раньше.
test('повтор того же сообщения и старое сообщение — бот отвечает сам', async () => {
  const db = linked(); const { sent, deps } = harness();
  setAiEnabled(db, true, 1, '2020-01-01T00:00:00Z');
  await handleUpdate(db, 'x', textMsg('Сколько стоит УЗИ?', 21), deps);
  assert.equal(sent.length, 0, 'первое — взял ИИ');
  await handleUpdate(db, 'x', textMsg('Сколько стоит УЗИ?', 21), deps);
  assert.equal(sent.length, 1, 'повтор (dup) — бот подтверждает');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_chat_jobs').get().n, 1);

  assert.equal(aiTakesTelegramText(db, { chatId: 100, messageId: 22, createdAt: '2019-12-31T00:00:00Z' }), false, 'old — не берёт');
  assert.equal(aiTakesTelegramText(db, { chatId: 100, messageId: 21, createdAt: iso() }), false, 'dup — не берёт');
  assert.equal(aiTakesTelegramText(db, { chatId: 100, messageId: 23, createdAt: iso() }), true, 'queued — берёт');
});
