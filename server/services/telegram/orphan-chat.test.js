// TELEGRAM_ORPHAN_CHAT_V1 — чат, который написал НЕсвязанный человек.
//
// Реальный случай: пациент нажал /start, набрал свой номер ТЕКСТОМ (вместо
// кнопки «Поделиться номером») и написал «готовы ли анализы». Связка не
// создалась — она делается только по контакту от Telegram, — и чат исчез из
// «Чата с пациентами»: список строится ИЗ telegram_links.
//
// При этом счётчик непрочитанных считает telegram_messages НАПРЯМУЮ. Получилось
// худшее сочетание: бейдж горит «3», открыть нечего, отметить прочитанным
// нельзя, а живой вопрос пациента никто не видит. Сообщения висели так с утра.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { listChats, markRead, unreadTotal, phoneFromChat, linkChatToPhone } from './chat.js';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (1,'a','x','admin','Админ')").run();
  // Связанный чат — обычный случай.
  db.prepare("INSERT INTO telegram_links (chat_id, phone, tg_name) VALUES ('100','998901112233','Алишер')").run();
  db.prepare("INSERT INTO patients (id, full_name, mrn, phone) VALUES (500,'Хожиев Мухаммаджон','P-1','+998 95 571 00 62')").run();
  const msg = db.prepare("INSERT INTO telegram_messages (chat_id, direction, kind, text, created_at) VALUES (?,?,?,?,?)");
  msg.run('100', 'in', 'text', 'Здравствуйте', '2026-08-19T03:00:00Z');
  // Несвязанный чат: /start, номер текстом, затем вопрос.
  msg.run('7771020282', 'in',  'text',   '/start',             '2026-08-19T03:38:53Z');
  msg.run('7771020282', 'out', 'system', 'Assalomu alaykum!',  '2026-08-19T03:38:54Z');
  msg.run('7771020282', 'in',  'text',   '998 95 571-00-62',   '2026-08-19T03:39:08Z');
  msg.run('7771020282', 'in',  'text',   'analizlari tayyor?', '2026-08-19T04:56:55Z');
  return db;
}

test('несвязанный чат ПОПАДАЕТ в список', () => {
  const db = seed();
  const chats = listChats(db, {});
  const orphan = chats.find((c) => c.chat_id === '7771020282');
  assert.ok(orphan, 'чат без связки должен быть виден — иначе сообщение теряется');
  assert.equal(orphan.unlinked, true);
  assert.equal(orphan.unread, 3, 'три входящих непрочитанных');
  assert.match(orphan.last_text, /analizlari/);
  db.close();
});

test('связанные чаты остаются как были', () => {
  const db = seed();
  const linked = listChats(db, {}).find((c) => c.chat_id === '100');
  assert.ok(linked);
  assert.equal(!!linked.unlinked, false);
  assert.equal(linked.tg_name, 'Алишер');
  db.close();
});

// Номер, набранный текстом, — подсказка сотруднику, а не основание связать.
test('из переписки достаётся набранный номер и найденный по нему пациент', () => {
  const db = seed();
  const orphan = listChats(db, {}).find((c) => c.chat_id === '7771020282');
  assert.equal(orphan.candidate_phone, '998955710062', 'номер из текста, только цифры');
  assert.equal(orphan.candidates.length, 1);
  assert.match(orphan.candidates[0].name, /Хожиев/);
  db.close();
});

test('phoneFromChat берёт номер только из входящих и игнорирует мусор', () => {
  const db = seed();
  assert.equal(phoneFromChat(db, '7771020282'), '998955710062');
  assert.equal(phoneFromChat(db, '100'), '', 'в этом чате номера не писали');
  db.close();
});

// Счётчик должен сходиться с тем, что видно на экране: раньше он считал
// сообщения, до которых нельзя было добраться.
test('теперь непрочитанные можно отметить прочитанными', () => {
  const db = seed();
  assert.equal(unreadTotal(db), 4);
  markRead(db, '7771020282');
  assert.equal(unreadTotal(db), 1, 'остался только связанный чат');
  db.close();
});

test('связывание вручную создаёт связку и снимает пометку', () => {
  const db = seed();
  const out = linkChatToPhone(db, { chat_id: '7771020282', phone: '998955710062' }, { id: 1, role: 'admin' });
  assert.ok(out.link.id);
  assert.equal(out.link.phone, '998955710062');
  const chat = listChats(db, {}).find((c) => c.chat_id === '7771020282');
  assert.equal(!!chat.unlinked, false, 'после связывания это обычный чат');
  assert.equal(chat.patients.length, 1);
  db.close();
});

test('связать без номера нельзя', () => {
  const db = seed();
  for (const bad of ['', null, undefined, 'абв', '123']) {
    assert.throws(() => linkChatToPhone(db, { chat_id: '7771020282', phone: bad }, { id: 1, role: 'admin' }), /номер|phone/i, JSON.stringify(bad));
  }
  db.close();
});

// Повторное связывание того же чата не должно плодить активные связки:
// активная у чата ровно одна (уникальный индекс в миграции 060).
test('повторное связывание заменяет прежнюю связку', () => {
  const db = seed();
  linkChatToPhone(db, { chat_id: '7771020282', phone: '998955710062' }, { id: 1, role: 'admin' });
  linkChatToPhone(db, { chat_id: '7771020282', phone: '998901112299' }, { id: 1, role: 'admin' });
  const active = db.prepare("SELECT COUNT(*) c FROM telegram_links WHERE chat_id='7771020282' AND revoked_at IS NULL").get().c;
  assert.equal(active, 1);
  db.close();
});
