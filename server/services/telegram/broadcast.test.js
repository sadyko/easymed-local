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
