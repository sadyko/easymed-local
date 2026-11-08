import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { conversationFor } from './conversation.js';

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

test('Telegram: последние сообщения, телефон связки — отдельно, не в переписке', () => {
  const db = fresh();
  db.prepare(`INSERT INTO telegram_links (chat_id, phone, tg_user_id, tg_name, last_seen_at) VALUES ('100','+998901112233','u','Алишер','2026-11-08T10:00:00Z')`).run();
  const put = (dir, text, kind = 'text', byAi = 0) => db.prepare('INSERT INTO telegram_messages (chat_id, direction, text, kind, by_ai) VALUES (?,?,?,?,?)').run('100', dir, text, kind, byAi);
  put('in', 'Здравствуйте, сколько стоит УЗИ?');
  put('out', 'Ваше сообщение получено', 'system');
  const c = conversationFor(db, 'telegram', '100');
  assert.equal(c.patientName, 'Алишер');
  assert.equal(c.linkPhone, '+998901112233');
  assert.deepEqual(c.transcript, [{ from: 'patient', text: 'Здравствуйте, сколько стоит УЗИ?' }], 'служебные ответы бота — не переписка');
  assert.ok(!JSON.stringify(c.transcript).includes('998901112233'));
  put('out', 'УЗИ стоит 100 000', 'text', 1);
  assert.equal(conversationFor(db, 'telegram', '100').transcript[1].from, 'clinic', 'ответ ИИ — реплика клиники');
});

test('Meta: личная переписка', () => {
  const db = fresh();
  const conv = db.prepare(`INSERT INTO meta_conversations (platform, conv_id, peer_id, peer_name, updated_time) VALUES ('instagram','c1','p1','ann','2026-11-08T11:00:00Z')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO meta_messages (conversation_id, msg_id, direction, text, created_at) VALUES (?, 'm1', 'in', 'Salom', '2026-11-08T11:00:00Z')`).run(conv);
  assert.deepEqual(conversationFor(db, 'meta_dm', String(conv)).transcript, [{ from: 'patient', text: 'Salom' }]);
});

test('Meta: комментарий — вся нитка по времени, текст поста из корня', () => {
  const db = fresh();
  const ins = db.prepare(`INSERT INTO meta_comments (platform, comment_id, parent_id, root_id, post_id, post_text, author_id, author_name, text, created_at, is_page)
                          VALUES ('facebook',?,?,?,'p',?,?,?,?,?,?)`);
  const rootRow = ins.run('k1', '', '', 'Акция на УЗИ', 'a', 'Bob', 'Сколько?', '2026-11-08T11:00:00Z', 0).lastInsertRowid;
  ins.run('k2', 'k1', 'k1', '', 'pg', 'Клиника', 'Напишем вам в личные', '2026-11-08T11:01:00Z', 1);
  const last = ins.run('k3', 'k1', 'k1', '', 'c', 'Carol', 'А в субботу работаете?', '2026-11-08T11:02:00Z', 0).lastInsertRowid;
  ins.run('z1', '', '', 'Акция на УЗИ', 'a', 'Другой', 'Чужая нитка', '2026-11-08T11:03:00Z', 0);
  const expected = [
    { from: 'patient', text: 'Сколько?' },
    { from: 'clinic', text: '(ответ сотрудника клиники)' },
    { from: 'patient', text: 'А в субботу работаете?' },
  ];
  for (const key of [rootRow, last]) {
    const c = conversationFor(db, 'meta_comment', String(key));
    assert.equal(c.postText, 'Акция на УЗИ');
    assert.equal(c.patientName, 'Carol');
    assert.deepEqual(c.transcript, expected);
  }
});

test('сотрудники не опознаются, команды бота и длинные тексты обрабатываются', () => {
  const db = fresh();
  const uid = db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('op','x','Иванова Мария','receptionist')").run().lastInsertRowid;
  const put = (dir, text, by, sent) => db.prepare('INSERT INTO telegram_messages (chat_id, direction, text, kind, by_ai, sent_by) VALUES (?,?,?,?,?,?)').run('7', dir, text, 'text', by, sent);
  put('in', '/start', 0, null);
  put('in', 'А'.repeat(5000), 0, null);
  put('out', 'Добрый день. — Иванова Мария', 0, uid);
  put('out', 'Ответ ИИ', 1, null);
  const t = conversationFor(db, 'telegram', '7').transcript;
  assert.deepEqual(t.map((x) => x.text.length), [2000, 26, 8]);
  assert.equal(t[1].text, '(ответ сотрудника клиники)');
  assert.equal(t[2].text, 'Ответ ИИ');
  assert.ok(!JSON.stringify(t).includes('Иванова'));

  const conv = db.prepare(`INSERT INTO meta_conversations (platform, conv_id, peer_id, peer_name, updated_time) VALUES ('messenger','c2','p','x','2026-11-08T11:00:00Z')`).run().lastInsertRowid;
  const m = db.prepare(`INSERT INTO meta_messages (conversation_id, msg_id, direction, text, created_at, sent_by, by_ai) VALUES (?,?,?,?,?,?,?)`);
  m.run(conv, 'a', 'in', 'Привет', '2026-11-08T11:00:00Z', null, 0);
  m.run(conv, 'b', 'out', 'Здравствуйте — Иванова Мария', '2026-11-08T11:01:00Z', uid, 0);
  const d = conversationFor(db, 'meta_dm', String(conv)).transcript;
  assert.equal(d[1].text, '(ответ сотрудника клиники)');
  assert.ok(!JSON.stringify(d).includes('Иванова'));
});

// AI_CHAT_V1: ответ, набранный сотрудником прямо в приложении Meta (Business
// Suite, Instagram), приходит опросом без sent_by — и всё равно не ИИ: его
// подпись и имя сотрудника наружу не уходят.
test('Meta: ответ сотрудника из приложения Meta (sent_by пуст) — тоже заглушка; ответ ИИ — с текстом', () => {
  const db = fresh();
  const conv = db.prepare(`INSERT INTO meta_conversations (platform, conv_id, peer_id, peer_name, updated_time) VALUES ('instagram','c3','p','x','2026-11-08T11:00:00Z')`).run().lastInsertRowid;
  const m = db.prepare(`INSERT INTO meta_messages (conversation_id, msg_id, direction, text, created_at, sent_by, by_ai) VALUES (?,?,?,?,?,?,?)`);
  m.run(conv, 'a', 'in', 'Привет', '2026-11-08T11:00:00Z', null, 0);
  m.run(conv, 'b', 'out', 'Здравствуйте, это Мария из регистратуры', '2026-11-08T11:01:00Z', null, 0);
  m.run(conv, 'c', 'out', 'УЗИ стоит 150 000 сум.', '2026-11-08T11:02:00Z', null, 1);
  const d = conversationFor(db, 'meta_dm', String(conv)).transcript;
  assert.deepEqual(d, [
    { from: 'patient', text: 'Привет' },
    { from: 'clinic', text: '(ответ сотрудника клиники)' },
    { from: 'clinic', text: 'УЗИ стоит 150 000 сум.' },
  ]);
});
