// REFERRALS_CRM_V1 — диалог бота для врачей-источников: подключение по номеру.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { handleUpdate, findSourceByPhone, findSourcesByPhone, activeLink, T } from './flow.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const src = db.prepare('INSERT INTO referral_sources (name, first_name, phone, active) VALUES (?,?,?,?)');
  src.run('Набиев Ойбек', 'Ойбек', '+998 90 310 65 70', 1);
  src.run('Абдурахманова Дилара', 'Дилара', '998912098887', 1);
  src.run('Выбывший Врач', 'Выбывший', '+998901111111', 0);
  const id = (n) => db.prepare('SELECT id FROM referral_sources WHERE name = ?').get(n).id;
  return { db, A: id('Набиев Ойбек'), B: id('Абдурахманова Дилара') };
}
function fakeApi() {
  const sent = [];
  const fetchImpl = async (url, opts) => {
    const method = String(url).split('/').pop();
    sent.push({ method, params: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
  return { sent, deps: { fetchImpl } };
}
const contactMsg = (chatId, fromId, phone, ownerId = fromId) => ({ message: {
  chat: { id: chatId }, from: { id: fromId, first_name: 'Ойбек', last_name: 'Набиев', username: 'oybek' },
  contact: { phone_number: phone, user_id: ownerId },
} });

test('findSourceByPhone: ключ номера — те же 9 цифр, что в CRM; короткий номер и выбывший врач не находятся', () => {
  const { db, A, B } = fresh();
  assert.equal(findSourceByPhone(db, '+998903106570').id, A, 'записано с пробелами, пришло слитно');
  assert.equal(findSourceByPhone(db, '903106570').id, A, 'без кода страны');
  assert.equal(findSourceByPhone(db, '+998 91 209 88 87').id, B);
  assert.equal(findSourceByPhone(db, '+998901111111'), null, 'выбывший (active = 0)');
  assert.equal(findSourceByPhone(db, '3106570'), null, 'короче полного номера — не ищем');
  assert.equal(findSourceByPhone(db, ''), null);
});

test('/start без связки — приветствие с кнопкой контакта; свой контакт известного номера — связка ЖДЁТ подтверждения клиники; после подтверждения — «Вы подключены»', async () => {
  const { db, A } = fresh();
  const { sent, deps } = fakeApi();
  await handleUpdate(db, 'tok', { message: { chat: { id: 500 }, from: { id: 500 }, text: '/start' } }, deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.text, T.greeting);
  assert.equal(sent[0].params.reply_markup.keyboard[0][0].request_contact, true);

  await handleUpdate(db, 'tok', contactMsg(500, 500, '+998903106570'), deps);
  const link = activeLink(db, 500);
  assert.ok(link, 'связка создана');
  assert.equal(link.referral_source_id, A);
  assert.equal(link.phone, '998903106570');
  assert.equal(link.tg_username, 'oybek');
  assert.equal(link.tg_name, 'Ойбек Набиев');
  // FIX_318_V1 (M2) — подключение без согласия клиники больше не открывает имена пациентов.
  assert.equal(link.status, 'pending', 'ждёт администратора');
  assert.equal(sent[1].params.text, T.pending('Набиев Ойбек'));
  assert.deepEqual(sent[1].params.reply_markup, { remove_keyboard: true });

  await handleUpdate(db, 'tok', { message: { chat: { id: 500 }, from: { id: 500 }, text: '/start' } }, deps);
  assert.equal(sent[2].params.text, T.pending('Набиев Ойбек'), 'пока ждёт — напоминание, что ждёт');
  db.prepare("UPDATE doctor_bot_links SET status = 'confirmed', confirmed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(link.id);

  await handleUpdate(db, 'tok', { message: { chat: { id: 500 }, from: { id: 500 }, text: 'спасибо' } }, deps);
  assert.equal(sent[3].params.text, T.gotMessage, 'подключённому — что сообщения не читаются');
  await handleUpdate(db, 'tok', { message: { chat: { id: 500 }, from: { id: 500 }, text: '/start' } }, deps);
  assert.equal(sent[4].params.text, T.linked('Набиев Ойбек'), '/start подключённого — напоминание, кто он');
  await handleUpdate(db, 'tok', contactMsg(500, 500, '+998903106570'), deps);
  assert.equal(sent[5].params.text, T.linked('Набиев Ойбек'), 'тот же номер ещё раз — подтверждение не сбрасывается');
  assert.equal(activeLink(db, 500).status, 'confirmed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM doctor_bot_links').get().n, 1);
});

test('M2 (повтор R3): номер указан у двух врачей — связки нет, просьба позвонить в клинику', async () => {
  const { db } = fresh();
  db.prepare("INSERT INTO referral_sources (name, first_name, phone, active) VALUES ('Регистратура поликлиники', 'Рег', '998903106570', 1)").run();
  assert.equal(findSourceByPhone(db, '+998903106570'), null, 'неоднозначный номер — никто');
  assert.equal(findSourcesByPhone(db, '+998903106570').length, 2);
  const { sent, deps } = fakeApi();
  await handleUpdate(db, 'tok', contactMsg(510, 510, '+998903106570'), deps);
  assert.equal(sent[0].params.text, T.ambiguous);
  assert.equal(activeLink(db, 510), null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM doctor_bot_links').get().n, 0);
});

test('чужой контакт и незнакомый номер — отказ с кнопкой, связки нет', async () => {
  const { db } = fresh();
  const { sent, deps } = fakeApi();
  await handleUpdate(db, 'tok', contactMsg(600, 600, '+998903106570', 601), deps);
  assert.equal(sent[0].params.text, T.notOwn);
  assert.equal(activeLink(db, 600), null);
  await handleUpdate(db, 'tok', contactMsg(600, 600, '+998909999999'), deps);
  assert.equal(sent[1].params.text, T.unknown);
  assert.equal(activeLink(db, 600), null);
});

test('повторное подключение: тот же врач с другого чата или другой врач с того же чата отзывает прежнюю связку', async () => {
  const { db, A, B } = fresh();
  const { deps } = fakeApi();
  await handleUpdate(db, 'tok', contactMsg(700, 700, '+998903106570'), deps);
  await handleUpdate(db, 'tok', contactMsg(701, 701, '+998903106570'), deps);
  assert.equal(activeLink(db, 700), null, 'старый чат того же врача отозван');
  assert.equal(activeLink(db, 701).referral_source_id, A);
  await handleUpdate(db, 'tok', contactMsg(701, 701, '998912098887'), deps);
  const l = activeLink(db, 701);
  assert.equal(l.referral_source_id, B, 'тот же чат теперь — другой врач');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM doctor_bot_links WHERE revoked_at IS NULL').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM doctor_bot_links').get().n, 3, 'история связок остаётся');
});

test('кнопка «Получил»: ставит viewed_at только своему чату и отвечает на callback', async () => {
  const { db, A } = fresh();
  const { sent, deps } = fakeApi();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (3, 'd', 'x', 'doctor')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (10, 'Пациент', '+998900000001')").run();
  db.prepare("INSERT INTO visits (id, patient_id, doctor_id, visit_date, status) VALUES (100, 10, 3, '2026-10-26T07:00:00.000Z', 'arrived')").run();
  db.prepare("INSERT INTO doctor_bot_links (referral_source_id, chat_id, phone) VALUES (?, '800', '998903106570')").run(A);
  const link = db.prepare('SELECT id FROM doctor_bot_links').get().id;
  db.prepare("INSERT INTO doctor_bot_notifications (id, visit_id, referral_source_id, link_id, chat_id, text) VALUES (1, 100, ?, ?, '800', 'x')").run(A, link);

  await handleUpdate(db, 'tok', { callback_query: { id: 'cq1', data: 'seen:1', message: { chat: { id: 999 } } } }, deps);
  assert.equal(db.prepare('SELECT viewed_at FROM doctor_bot_notifications WHERE id = 1').get().viewed_at, null, 'чужой чат не отмечает');
  await handleUpdate(db, 'tok', { callback_query: { id: 'cq2', data: 'seen:1', message: { chat: { id: 800 } } } }, deps);
  assert.ok(db.prepare('SELECT viewed_at FROM doctor_bot_notifications WHERE id = 1').get().viewed_at);
  const acks = sent.filter((s) => s.method === 'answerCallbackQuery');
  assert.equal(acks.length, 2);
  assert.equal(acks[1].params.text, T.seen);
});
