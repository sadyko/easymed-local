// TELEGRAM_BROADCAST_V1 — отбор получателей, подтверждение и рассылка.
//
// Главное здесь — что предпросмотр не врёт: число, которое администратор видит
// и подтверждает, должно совпасть с числом тех, кому реально ушло. Ошибка в эту
// сторону означает сообщение, улетевшее не тем людям, и отозвать его нельзя.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { resolveAudience, previewAudience, runBroadcast, composeText, botStats } from './broadcast.js';
import { telegramBroadcastSend } from '../rpc/telegram.js';

const admin = { id: 1, role: 'admin' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,?,?,?,?)')
    .run('boss', 'x', 'Админ', 'admin');

  const pat = db.prepare('INSERT INTO patients (full_name, phone) VALUES (?,?)');
  const a = pat.run('Алиев А.', '+998 90 111 22 33').lastInsertRowid;
  const b = pat.run('Каримов К.', '+998 91 444 55 66').lastInsertRowid;
  const c = pat.run('Отвязанный О.', '+998 93 777 88 99').lastInsertRowid;

  const link = db.prepare('INSERT INTO telegram_links (chat_id, phone, tg_name) VALUES (?,?,?)');
  link.run('100', '998901112233', 'Алишер');
  link.run('200', '998914445566', 'Комил');
  link.run('300', '998937778899', 'Отвязанный');
  db.prepare("UPDATE telegram_links SET revoked_at='2026-08-01T00:00:00Z' WHERE chat_id='300'").run();

  return { db, a, b, c };
}

// Ловушка вместо сети.
function harness({ failFor = [], blockFor = [] } = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      fetchImpl: async (url, opts) => {
        const p = JSON.parse(opts.body);
        if (blockFor.includes(String(p.chat_id))) {
          return { ok: false, status: 403, json: async () => ({ ok: false, description: 'bot was blocked by the user' }) };
        }
        if (failFor.includes(String(p.chat_id))) {
          return { ok: false, status: 500, json: async () => ({ ok: false, description: 'server error' }) };
        }
        sent.push(p);
        return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
      },
    },
  };
}

test('отвязанные чаты в рассылку не попадают', () => {
  const { db } = seed();
  const aud = resolveAudience(db, {});
  assert.deepEqual(aud.map((a) => a.link.chat_id).sort(), ['100', '200']);
  db.close();
});

test('предпросмотр показывает столько же, сколько уйдёт', () => {
  const { db } = seed();
  const p = previewAudience(db, {});
  assert.equal(p.count, 2);
  assert.equal(p.count, resolveAudience(db, {}).length, 'предпросмотр и отбор — одна и та же функция, не две');
  assert.equal(p.sample.length, 2);
  db.close();
});

test('фильтр по долгу оставляет только должников', () => {
  const { db, a } = seed();
  db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?, 100000, 0, 'unpaid')").run(a);

  const only = resolveAudience(db, { unpaid: true });
  assert.deepEqual(only.map((x) => x.link.chat_id), ['100']);
  db.close();
});

test('аннулированный счёт долгом не считается', () => {
  const { db, b } = seed();
  db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?, 50000, 0, 'void')").run(b);
  assert.deepEqual(resolveAudience(db, { unpaid: true }).map((x) => x.link.chat_id), []);
  db.close();
});

test('фильтр по датам визита сужает аудиторию', () => {
  const { db, a, b } = seed();
  db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-08-10')").run(a);
  db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-01-05')").run(b);

  assert.deepEqual(
    resolveAudience(db, { visited_from: '2026-08-01', visited_to: '2026-08-31' }).map((x) => x.link.chat_id),
    ['100']);
  db.close();
});

test('узбекский текст уходит тем же сообщением', () => {
  assert.equal(composeText('Привет', 'Salom'), 'Привет\n\nSalom');
  assert.equal(composeText('Привет', ''), 'Привет');
  assert.equal(composeText('  Привет  ', '  '), 'Привет');
});

test('рассылка доходит до всех и записывает итог', async () => {
  const { db } = seed();
  const { sent, deps } = harness();
  const bc = db.prepare("INSERT INTO telegram_broadcasts (text_ru, audience_count) VALUES ('Тест', 2) RETURNING id").get();
  for (const chat of ['100', '200']) {
    db.prepare('INSERT INTO telegram_broadcast_targets (broadcast_id, chat_id) VALUES (?,?)').run(bc.id, chat);
  }

  const res = await runBroadcast(db, 'tok', bc.id, 'Клиника работает до 18:00', deps);
  assert.deepEqual(res, { sent: 2, failed: 0 });
  assert.deepEqual(sent.map((s) => String(s.chat_id)).sort(), ['100', '200']);
  assert.equal(sent[0].text, 'Клиника работает до 18:00');

  const row = db.prepare('SELECT * FROM telegram_broadcasts WHERE id=?').get(bc.id);
  assert.equal(row.status, 'done');
  assert.equal(row.sent_count, 2);
  db.close();
});

test('заблокировавший бота помечается и больше не попадает в аудиторию', async () => {
  const { db } = seed();
  const { deps } = harness({ blockFor: ['200'] });
  const bc = db.prepare("INSERT INTO telegram_broadcasts (text_ru, audience_count) VALUES ('Тест', 2) RETURNING id").get();
  for (const chat of ['100', '200']) {
    db.prepare('INSERT INTO telegram_broadcast_targets (broadcast_id, chat_id) VALUES (?,?)').run(bc.id, chat);
  }

  const res = await runBroadcast(db, 'tok', bc.id, 'Текст', deps);
  assert.equal(res.sent, 1);
  assert.equal(res.failed, 1);

  const target = db.prepare("SELECT * FROM telegram_broadcast_targets WHERE chat_id='200'").get();
  assert.equal(target.status, 'blocked', 'блокировка — это решение пациента, а не сбой отправки');

  // И главное: следующая рассылка его уже не беспокоит.
  assert.deepEqual(resolveAudience(db, {}).map((a) => a.link.chat_id), ['100']);
  db.close();
});

test('обычный сбой не помечает пациента заблокировавшим', async () => {
  const { db } = seed();
  const { deps } = harness({ failFor: ['200'] });
  const bc = db.prepare("INSERT INTO telegram_broadcasts (text_ru, audience_count) VALUES ('Т',2) RETURNING id").get();
  db.prepare('INSERT INTO telegram_broadcast_targets (broadcast_id, chat_id) VALUES (?,?)').run(bc.id, '200');

  await runBroadcast(db, 'tok', bc.id, 'Текст', deps);
  assert.equal(db.prepare("SELECT status FROM telegram_broadcast_targets WHERE chat_id='200'").get().status, 'failed');
  assert.equal(db.prepare("SELECT blocked_at FROM telegram_links WHERE chat_id='200'").get().blocked_at, null,
    'упавшая сеть не означает, что пациент ушёл');
  db.close();
});

test('неверное подтверждение числа получателей отменяет отправку', () => {
  const { db } = seed();
  db.prepare("UPDATE telegram_settings SET enabled=1, bot_token_enc='x' WHERE id=1").run();
  // Администратор подтвердил 5, а получателей 2 — значит он смотрел на другое
  // число, и рассылку начинать нельзя.
  assert.throws(
    () => telegramBroadcastSend(db, { text_ru: 'Привет', confirm_count: 5 }, admin),
    (e) => e.status === 409 && /изменилось/.test(e.message));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM telegram_broadcasts').get().c, 0, 'ничего не создано');
  db.close();
});

test('пустое сообщение и выключенный бот отправку не начинают', () => {
  const { db } = seed();
  assert.throws(() => telegramBroadcastSend(db, { text_ru: '   ', confirm_count: 2 }, admin), /пустым/);
  // Бот выключен: рассылать некому и нечем.
  assert.throws(() => telegramBroadcastSend(db, { text_ru: 'Привет', confirm_count: 2 }, admin), /выключен|токен/i);
  db.close();
});

test('рассылка закрыта для всех, кроме администратора', () => {
  const { db } = seed();
  for (const u of [{ id: 2, role: 'registrar' }, null, {}]) {
    assert.throws(() => telegramBroadcastSend(db, { text_ru: 'Привет', confirm_count: 2 }, u), (e) => e.status === 403);
  }
  db.close();
});

test('охват считается от недавних пациентов, а не от всего архива', () => {
  const { db, a } = seed();
  db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, date('now'))").run(a);
  // Пациент из архива, который не приходил годами, охват не размывает.
  const old = db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Старый','+998 99 000 00 00')").run().lastInsertRowid;
  db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2019-01-01')").run(old);

  const s = botStats(db);
  assert.equal(s.recent_patients, 1, 'считаем только тех, кто лечится сейчас');
  assert.equal(s.recent_connected, 1);
  assert.equal(s.coverage_pct, 100);
  assert.equal(s.chats_active, 2);
  db.close();
});

// TG_DAILY_30_V1 — «сколько человек подключилось за месяц», по дням.
test('подключения за 30 дней: по дням, старые не попадают, отозванные не вычитаются', () => {
  const { db } = seed();   // три связки прямо сейчас, одна из них отозвана
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 19) + 'Z';
  const link = db.prepare('INSERT INTO telegram_links (chat_id, phone, tg_name, linked_at) VALUES (?,?,?,?)');
  // Двое в один день пять дней назад — должны слипнуться в одно ведро.
  link.run('401', '998900000001', 'Пятидневный-1', iso(5));
  link.run('402', '998900000002', 'Пятидневный-2', iso(5));
  // Сорок дней назад — за окном, в счёт не идёт.
  link.run('403', '998900000003', 'Старый', iso(40));

  const s = botStats(db);
  assert.equal(s.started_30d, 5, 'трое из seed (отозванный тоже ПОДКЛЮЧАЛСЯ) плюс двое пятидневных');
  const today = new Date().toISOString().slice(0, 10);
  const byDay = Object.fromEntries(s.daily_30d.map((d) => [d.day, d.c]));
  assert.equal(byDay[today], 3, 'связки seed легли в сегодняшнее ведро');
  assert.equal(byDay[iso(5).slice(0, 10)], 2, 'один день — одно ведро');
  assert.equal(byDay[iso(40).slice(0, 10)], undefined, 'сорокадневная связка за окном');
  db.close();
});

// ---------------------------------------------------------------------------
// TG_BROADCAST_FILTERS_V1 (2026-10-17, владелец: «make the pop up wide and to
// the right side put detailed filters») — подробные фильтры получателей:
// пол, возраст, категория, филиал, врач, услуга и тип услуги, «не приходил
// с», долг. Ключи вне словаря отбрасываются, значения приводятся к типу.
// ---------------------------------------------------------------------------
import { normalizeFilters, broadcastOptions } from './broadcast.js';
import { telegramBroadcastOptions } from '../rpc/telegram.js';

function seedDetailed() {
  const { db, a, b } = seed();
  // Справочники — ДО ссылок на них: category_id и branch_id — внешние ключи.
  // Категория со своим номером (77): сидовые 1–3 заняты «Взрослый / Ребёнок / Новорождённый».
  db.prepare("INSERT OR IGNORE INTO patient_categories (id, name) VALUES (77, 'VIP')").run();
  db.prepare("INSERT OR IGNORE INTO branches (id, name) VALUES (1, 'Главный'), (2, 'Филиал 2')").run();
  // a — женщина 1990 г. р., категория 77, филиал 1; b — мужчина 2015 г. р., без категории, филиал 2.
  db.prepare("UPDATE patients SET gender='female', date_of_birth='1990-05-20', category_id=77, branch_id=1 WHERE id=?").run(a);
  db.prepare("UPDATE patients SET gender='male', date_of_birth='2015-02-01', branch_id=2 WHERE id=?").run(b);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (7, 'doc', 'x', 'Врач Один', 'doctor', 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type_id) VALUES (501, 'УЗИ брюшной полости', 100000, 2), (502, 'Консультация терапевта', 50000, 1)").run();
  // a: визит 2026-08-10 к врачу 7 с УЗИ (тип 2); b: визит 2026-01-05 с консультацией (тип 1), к врачу не привязан.
  const va = db.prepare("INSERT INTO visits (patient_id, visit_date, doctor_id, branch_id) VALUES (?, '2026-08-10', 7, 1)").run(a).lastInsertRowid;
  const vb = db.prepare("INSERT INTO visits (patient_id, visit_date, branch_id) VALUES (?, '2026-01-05', 2)").run(b).lastInsertRowid;
  db.prepare('INSERT INTO visit_services (visit_id, service_id) VALUES (?, 501)').run(va);
  db.prepare('INSERT INTO visit_services (visit_id, service_id) VALUES (?, 502)').run(vb);
  return { db, a, b };
}
const chats = (db, f) => resolveAudience(db, f).map((x) => x.link.chat_id).sort();

test('normalizeFilters: словарь ключей закрыт, значения приводятся к типу, мусор отбрасывается', () => {
  assert.deepEqual(normalizeFilters(null), {});
  assert.deepEqual(normalizeFilters({ foo: 1, 'drop table': 2 }), {});
  assert.deepEqual(normalizeFilters({ gender: 'female', category_id: '2', branch_id: 1, doctor_id: '7', service_id: 501, service_type_id: '2',
    age_from: '18', age_to: 65, visited_from: '2026-08-01', visited_to: '2026-08-31', not_visited_since: '2026-06-01', unpaid: 1 }), {
    gender: 'female', category_id: 2, branch_id: 1, doctor_id: 7, service_id: 501, service_type_id: 2,
    age_from: 18, age_to: 65, visited_from: '2026-08-01', visited_to: '2026-08-31', not_visited_since: '2026-06-01', unpaid: true });
  assert.deepEqual(normalizeFilters({ gender: 'robot', category_id: 'x', age_from: -5, age_to: 500, visited_from: '31.08.2026', unpaid: false, doctor_id: 0 }), {});
});

test('пол, возраст, категория и филиал сужают аудиторию; возраст без даты рождения — мимо', () => {
  const { db, a } = seedDetailed();
  assert.deepEqual(chats(db, { gender: 'female' }), ['100']);
  assert.deepEqual(chats(db, { gender: 'male' }), ['200']);
  assert.deepEqual(chats(db, { age_from: 18 }), ['100']);
  assert.deepEqual(chats(db, { age_to: 17 }), ['200']);
  assert.deepEqual(chats(db, { age_from: 30, age_to: 40 }), ['100']);
  assert.deepEqual(chats(db, { category_id: 77 }), ['100']);
  assert.deepEqual(chats(db, { category_id: 2 }), [], 'сидовая категория 2 никому не присвоена');
  assert.deepEqual(chats(db, { branch_id: 2 }), ['200']);
  db.prepare('UPDATE patients SET date_of_birth = NULL WHERE id = ?').run(a);
  assert.deepEqual(chats(db, { age_from: 18 }), [], 'без даты рождения возраст неизвестен — в выборку по возрасту не попадает');
  db.close();
});

test('врач, услуга и тип услуги — по визитам и строкам услуг; «не приходил с» — по отсутствию визитов после даты', () => {
  const { db } = seedDetailed();
  assert.deepEqual(chats(db, { doctor_id: 7 }), ['100']);
  assert.deepEqual(chats(db, { service_id: 502 }), ['200']);
  assert.deepEqual(chats(db, { service_type_id: 2 }), ['100'], 'УЗИ заведено с type_id 2');
  assert.deepEqual(chats(db, { service_type_id: 1 }), ['200']);
  assert.deepEqual(chats(db, { not_visited_since: '2026-06-01' }), ['200'], 'b последний раз был в январе');
  assert.deepEqual(chats(db, { not_visited_since: '2026-01-01' }), [], 'оба приходили после Нового года');
  // Сочетание — пересечение.
  assert.deepEqual(chats(db, { gender: 'female', service_type_id: 2, visited_from: '2026-08-01' }), ['100']);
  assert.deepEqual(chats(db, { gender: 'female', service_type_id: 1 }), []);
  db.close();
});

test('broadcastOptions — врачи, категории, филиалы, типы услуг и услуги для выпадающих списков; RPC — только с правом на бота', () => {
  const { db } = seedDetailed();
  const o = broadcastOptions(db);
  assert.deepEqual(o.doctors.map((d) => [d.id, d.full_name]), [[7, 'Врач Один']]);
  assert.ok(o.categories.some((c) => c.id === 77 && c.name === 'VIP'));
  assert.deepEqual(o.branches.map((b) => b.id), [1, 2]);
  assert.ok(o.service_types.some((t) => t.id === 2 && typeof t.name === 'string' && t.name), 'сидовые типы услуг на месте');
  assert.ok(o.services.some((s) => s.id === 501 && s.name === 'УЗИ брюшной полости' && s.type_id === 2));
  assert.deepEqual(telegramBroadcastOptions(db, {}, admin).doctors.length, 1);
  assert.throws(() => telegramBroadcastOptions(db, {}, { id: 2, role: 'registrar' }), (e) => e.status === 403);
  db.close();
});
