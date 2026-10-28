// REFERRALS_CRM_V1 — уведомление врачу о пришедшем пациенте: кого, когда, один раз.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { pendingNotifications, runNotifyScan, composeMessage, QUIET_MINUTES, LOOKBACK_DAYS, SEEN_BUTTON } from './notify.js';
import { TelegramError } from '../telegram/api.js';

const NOW = new Date('2026-10-26T09:00:00.000Z');
const iso = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const nowIso = NOW.toISOString();

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (3, 'd', 'x', 'doctor')").run();
  db.prepare("INSERT INTO referral_sources (name, first_name, phone) VALUES ('Набиев Ойбек', 'Ойбек', '+998903106570')").run();
  db.prepare("INSERT INTO referral_sources (name, first_name, phone) VALUES ('Без Бота', 'Без', '+998901111111')").run();
  const A = db.prepare("SELECT id FROM referral_sources WHERE name = 'Набиев Ойбек'").get().id;
  const C = db.prepare("SELECT id FROM referral_sources WHERE name = 'Без Бота'").get().id;
  db.prepare("INSERT INTO patients (id, full_name, phone, referral_source_id) VALUES (10, 'Иванов Иван', '+998900000001', ?)").run(A);
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (11, 'Петрова Анна', '+998900000002')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'УЗИ брюшной полости', 100000), (2, 'Консультация', 50000)").run();
  // Связка подключена и подтверждена администратором час назад (FIX_318_V1, M2 — без подтверждения бот молчит).
  db.prepare("INSERT INTO doctor_bot_links (referral_source_id, chat_id, phone, linked_at, status, confirmed_at) VALUES (?, '800', '998903106570', ?, 'confirmed', ?)").run(A, iso(60), iso(60));
  const link = db.prepare('SELECT id FROM doctor_bot_links').get().id;
  const visit = db.prepare('INSERT INTO visits (id, patient_id, doctor_id, visit_date, status, referral_source_id, updated_at) VALUES (?,?,?,?,?,?,?)');
  const service = db.prepare('INSERT INTO visit_services (visit_id, service_id, created_at) VALUES (?,?,?)');
  return { db, A, C, link, visit, service };
}
function fakeApi(failWith = null) {
  const sent = [];
  const fetchImpl = async (url, opts) => {
    sent.push({ method: String(url).split('/').pop(), params: JSON.parse(opts.body) });
    if (failWith) return { ok: false, status: failWith, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 77 } }) };
  };
  return { sent, deps: { fetchImpl, now: nowIso } };
}

test('кандидаты: пришедший визит подключённого врача, услуги добавлены ≥ 2 минут назад; остальное — нет', () => {
  const { db, A, C, visit, service } = fresh();
  // FIX_318_V1 (M2) — источник только из карточки пациента (в визите не указан) —
  // не повод писать врачу: однажды направленный пациент иначе «докладывал» бы
  // каждый свой визит в любое отделение.
  visit.run(100, 10, 3, iso(30), 'arrived', null, iso(30));
  service.run(100, 1, iso(5));
  visit.run(107, 10, 3, iso(30), 'arrived', A, iso(30));              // источник визита → A, услуга 5 мин назад
  service.run(107, 1, iso(5));
  visit.run(101, 11, 3, iso(20), 'arrived', A, iso(20));              // источник визита → A, последняя услуга 1 мин назад → рано
  service.run(101, 1, iso(10)); service.run(101, 2, iso(1));
  visit.run(102, 11, 3, iso(15), 'scheduled', A, iso(15));            // не пришёл ещё
  visit.run(103, 11, 3, iso(15), 'arrived', C, iso(15));              // врач без бота
  visit.run(104, 11, 3, iso(90), 'arrived', A, iso(90));              // пришёл до подключения (updated 90 мин назад, связка 60)
  visit.run(105, 11, 3, iso(60 * 24 * 5), 'arrived', A, iso(60 * 24 * 5));   // старше LOOKBACK_DAYS
  visit.run(106, 11, 3, iso(10), 'arrived', A, iso(10));              // без услуг, визит изменён 10 мин назад → можно
  const got = pendingNotifications(db, { now: nowIso }).map((p) => p.visit_id);
  assert.deepEqual(got, [107, 106], 'визит 100 — источник только в карточке пациента — не уведомляется');
  assert.equal(QUIET_MINUTES, 2); assert.equal(LOOKBACK_DAYS, 3);
});

test('runNotifyScan: текст с ФИО и услугами без цен, кнопка «Получил», один раз на визит', async () => {
  const { db, A, visit, service } = fresh();
  visit.run(100, 10, 3, iso(30), 'arrived', A, iso(30));
  service.run(100, 1, iso(5)); service.run(100, 2, iso(4));
  const { sent, deps } = fakeApi();
  const r1 = await runNotifyScan(db, 'tok', deps);
  assert.deepEqual(r1, { candidates: 1, sent: 1 });
  assert.equal(sent.length, 1);
  const p = sent[0].params;
  assert.equal(p.chat_id, '800');
  assert.ok(p.text.includes('<b>Иванов Иван</b>') && p.text.includes('• УЗИ брюшной полости') && p.text.includes('• Консультация'));
  assert.ok(!/100\s?000|50\s?000/.test(p.text), 'цен в сообщении нет');
  assert.ok(p.text.includes('26.10.2026'));
  assert.deepEqual(p.reply_markup.inline_keyboard[0][0], { text: SEEN_BUTTON, callback_data: 'seen:1' });
  const row = db.prepare('SELECT message_id, viewed_at FROM doctor_bot_notifications WHERE visit_id = 100').get();
  assert.equal(row.message_id, '77');
  assert.equal(row.viewed_at, null);
  const r2 = await runNotifyScan(db, 'tok', deps);
  assert.deepEqual(r2, { candidates: 0, sent: 0 }, 'второй проход тот же визит не шлёт');
});

test('отказ Telegram: строка снимается (повтор в следующий проход); 403 — врач заблокировал бота — связка отзывается', async () => {
  const { db, A, visit, link } = fresh();
  visit.run(100, 10, 3, iso(30), 'arrived', A, iso(30));
  const { deps } = fakeApi(500);
  const warn = console.warn; console.warn = () => {};
  try {
    await runNotifyScan(db, 'tok', deps);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM doctor_bot_notifications').get().n, 0, 'после 500 строки нет — попробуем снова');
    assert.equal(db.prepare('SELECT revoked_at FROM doctor_bot_links WHERE id = ?').get(link).revoked_at, null);
    await runNotifyScan(db, 'tok', fakeApi(403).deps);
    assert.ok(db.prepare('SELECT revoked_at FROM doctor_bot_links WHERE id = ?').get(link).revoked_at, '403 — связка отозвана');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM doctor_bot_notifications').get().n, 0);
  } finally { console.warn = warn; }
  assert.ok(new TelegramError('x', { status: 403 }).status === 403);
});

test('composeMessage без услуг и с HTML в имени', () => {
  const text = composeMessage({ patient: 'A <b> & B', visitDate: '2026-10-26T07:00:00.000Z', services: [] });
  assert.ok(text.includes('<b>A &lt;b&gt; &amp; B</b>'));
  assert.ok(text.includes('Услуги ещё не добавлены.'));
});

// ---------------------------------------------------------------------------
// FIX_318_V1 — ревью 3.18.0 (бот для врачей-источников)
// ---------------------------------------------------------------------------

test('H3 (повтор R2): врача выключили или сменили ему номер — бот больше не пишет; проверка и в самой выборке, без триггера', () => {
  const { db, A, visit } = fresh();
  visit.run(100, 10, 3, iso(30), 'arrived', A, iso(30));
  assert.deepEqual(pendingNotifications(db, { now: nowIso }).map((p) => p.visit_id), [100], 'до выключения — пишет');
  db.prepare('UPDATE referral_sources SET active = 0 WHERE id = ?').run(A);
  assert.deepEqual(pendingNotifications(db, { now: nowIso }), [], 'выключенному врачу — нет');
  assert.ok(db.prepare('SELECT revoked_at FROM doctor_bot_links').get().revoked_at, 'подключение отозвано');

  // Подключение, записанное до триггера (или переписанное вручную): выборка сама
  // сверяет active и номер связки с номером врача.
  const { db: db2, A: A2, visit: visit2 } = fresh();
  db2.prepare('DROP TRIGGER doctor_bot_links_source_changed').run();
  visit2.run(100, 10, 3, iso(30), 'arrived', A2, iso(30));
  db2.prepare("UPDATE referral_sources SET phone = '+998911111111' WHERE id = ?").run(A2);
  assert.deepEqual(pendingNotifications(db2, { now: nowIso }), [], 'номер врача сменился — связка с прежним номером не пишет');
  db2.prepare("UPDATE referral_sources SET phone = '998 90 310 65 70' WHERE id = ?").run(A2);
  assert.deepEqual(pendingNotifications(db2, { now: nowIso }).map((p) => p.visit_id), [100], 'тот же номер в другой записи — пишет');
  db2.prepare('UPDATE referral_sources SET active = 0 WHERE id = ?').run(A2);
  assert.deepEqual(pendingNotifications(db2, { now: nowIso }), []);
});

test('M2: подключение без подтверждения администратора не получает ничего; визиты до подтверждения — тоже', () => {
  const { db, A, visit } = fresh();
  visit.run(100, 10, 3, iso(30), 'arrived', A, iso(30));
  db.prepare("UPDATE doctor_bot_links SET status = 'pending', confirmed_at = NULL").run();
  assert.deepEqual(pendingNotifications(db, { now: nowIso }), [], 'ожидает подтверждения — молчим');
  db.prepare("UPDATE doctor_bot_links SET status = 'confirmed', confirmed_at = ?").run(iso(10));
  assert.deepEqual(pendingNotifications(db, { now: nowIso }), [], 'визит изменён до подтверждения — не пишем');
  visit.run(101, 11, 3, iso(5), 'arrived', A, iso(5));
  assert.deepEqual(pendingNotifications(db, { now: nowIso }).map((p) => p.visit_id), [101]);
});

test('H3: врача выключили посреди прохода — оставшиеся уведомления ему не уходят', async () => {
  const { db, A, visit } = fresh();
  visit.run(100, 10, 3, iso(30), 'arrived', A, iso(30));
  visit.run(101, 11, 3, iso(20), 'arrived', A, iso(20));
  const sent = [];
  const fetchImpl = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    db.prepare('UPDATE referral_sources SET active = 0 WHERE id = ?').run(A);   // администратор выключил врача, пока шла отправка
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const r = await runNotifyScan(db, 'tok', { fetchImpl, now: nowIso });
  assert.equal(r.candidates, 2);
  assert.equal(r.sent, 1, 'второе уведомление не ушло');
  assert.equal(sent.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM doctor_bot_notifications').get().n, 1);
});
