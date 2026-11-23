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

test('/start без связки — приветствие с кнопкой контакта; свой контакт известного номера — подключён СРАЗУ, без подтверждения (DOCTOR_BOT_AUTO_LINK_V1)', async () => {
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
  // DOCTOR_BOT_AUTO_LINK_V1 (владелец, 2026-11-20) — врач есть в базе: подключён сразу.
  assert.equal(link.status, 'confirmed', 'подтверждение администратором больше не нужно');
  assert.ok(link.confirmed_at, 'время подключения записано — визиты до него бот не шлёт');
  assert.equal(link.confirmed_by, null, 'подтвердил номер, а не человек');
  assert.equal(sent[1].params.text, T.linked('Набиев Ойбек'));
  assert.deepEqual(sent[1].params.reply_markup, { remove_keyboard: true });

  await handleUpdate(db, 'tok', { message: { chat: { id: 500 }, from: { id: 500 }, text: '/start' } }, deps);
  assert.equal(sent[2].params.text, T.linked('Набиев Ойбек'), '/start сразу после подключения — «Вы подключены»');

  await handleUpdate(db, 'tok', { message: { chat: { id: 500 }, from: { id: 500 }, text: 'спасибо' } }, deps);
  assert.equal(sent[3].params.text, T.gotMessage, 'подключённому — что сообщения не читаются');
  await handleUpdate(db, 'tok', { message: { chat: { id: 500 }, from: { id: 500 }, text: '/start' } }, deps);
  assert.equal(sent[4].params.text, T.linked('Набиев Ойбек'), '/start подключённого — напоминание, кто он');
  await handleUpdate(db, 'tok', contactMsg(500, 500, '+998903106570'), deps);
  assert.equal(sent[5].params.text, T.linked('Набиев Ойбек'), 'тот же номер ещё раз — подключение не сбрасывается');
  assert.equal(activeLink(db, 500).status, 'confirmed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM doctor_bot_links').get().n, 1);
});

test('DOCTOR_BOT_AUTO_LINK_V1: связка, ждавшая подтверждения, подключается тем же номером ещё раз', async () => {
  const { db, A } = fresh();
  const { sent, deps } = fakeApi();
  db.prepare("INSERT INTO doctor_bot_links (referral_source_id, chat_id, phone, status) VALUES (?, '501', '998903106570', 'pending')").run(A);
  await handleUpdate(db, 'tok', contactMsg(501, 501, '+998903106570'), deps);
  const link = activeLink(db, 501);
  assert.equal(link.status, 'confirmed');
  assert.ok(link.confirmed_at);
  assert.equal(sent[0].params.text, T.linked('Набиев Ойбек'));
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

// DOCTOR_BOT_ADMIN_REVOKE_V1 (ревью слияния 2026-11-23) — администратор отклонил или отключил связку
// (revoked_by): тот же врач / тот же Telegram, снова отправив номер, НЕ подключается сам — связка ждёт
// подтверждения клиники, уведомления с именами пациентов ему не идут. Без решения администратора —
// автоподключение как было.
test('DOCTOR_BOT_ADMIN_REVOKE_V1: после «Отключить» администратора повторный номер — заявка ждёт клинику, а не связка', async () => {
  const { db, A } = fresh();
  const { sent, deps } = fakeApi();
  await handleUpdate(db, 'tok', contactMsg(501, 501, '+998903106570'), deps);
  assert.equal(activeLink(db, 501).status, 'confirmed', 'стенд: автоподключение не сработало');
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1, 'adm', 'x', 'Админ', 'admin')").run();
  db.prepare("UPDATE doctor_bot_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), revoked_by = 1 WHERE chat_id = '501'").run();
  sent.length = 0;
  await handleUpdate(db, 'tok', contactMsg(501, 501, '+998903106570'), deps);
  const again = activeLink(db, 501);
  assert.equal(again && again.status, 'pending', 'отключённый администратором врач подключился сам');
  assert.equal(sent[0].params.text, T.pending('Набиев Ойбек'));
  // ещё раз тем же номером — всё равно ждёт (не «подключается сейчас»)
  sent.length = 0;
  await handleUpdate(db, 'tok', contactMsg(501, 501, '+998903106570'), deps);
  assert.equal(activeLink(db, 501).status, 'pending');
  // с другого чата, но тот же Telegram — тоже ждёт
  await handleUpdate(db, 'tok', contactMsg(777, 501, '+998903106570'), deps);
  assert.equal(activeLink(db, 777).status, 'pending');
  // решения администратора нет (смена чата сама отзывает прежнюю связку без revoked_by) — сразу
  const fresh2 = fresh();
  await handleUpdate(fresh2.db, 'tok', contactMsg(601, 601, '+998903106570'), deps);
  await handleUpdate(fresh2.db, 'tok', contactMsg(602, 601, '+998903106570'), deps);
  assert.equal(activeLink(fresh2.db, 602).status, 'confirmed', 'смена чата без решения администратора требует подтверждения');
});
