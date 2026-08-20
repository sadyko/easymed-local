// TELEGRAM_BOT_V1 (mig 060) — хранилище настроек бота и журнала выдач.
//
// Проверяется не «таблицы создались», а три свойства, на которых держится
// безопасность раздела: токен недостижим через /api/db, автоотправка не может
// повториться, и связка чата — ровно одна.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { REGISTRY } from '../schema-registry.js';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('060 создаёт singleton настроек с выключенным ботом и пустым токеном', () => {
  const db = freshDb();
  const rows = db.prepare('SELECT * FROM telegram_settings').all();
  assert.equal(rows.length, 1, 'настройки бота — ровно одна строка');
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].enabled, 0, 'бот не включается сам по себе');
  assert.equal(rows[0].bot_token_enc, '', 'токена нет до того, как его ввёл администратор');
  db.close();
});

test('060 не даёт завести вторую строку настроек', () => {
  const db = freshDb();
  assert.throws(() => db.prepare('INSERT INTO telegram_settings (id) VALUES (2)').run());
  db.close();
});

test('телеграм-таблицы НЕ зарегистрированы в schema-registry', () => {
  // Реестр — белый список: отсутствие таблицы в нём делает токен недостижимым
  // через /api/db по построению. Тест ловит момент, когда кто-нибудь добавит
  // telegram_settings в реестр «чтобы UI было проще читать».
  for (const t of ['telegram_settings', 'telegram_links', 'telegram_deliveries', 'telegram_state']) {
    assert.equal(REGISTRY[t], undefined, `${t} не должна быть доступна через /api/db`);
  }
});

test('060 допускает ровно одну активную связку на чат, но переподключение после отзыва', () => {
  const db = freshDb();
  const ins = db.prepare("INSERT INTO telegram_links (chat_id, phone) VALUES (?, ?)");
  ins.run('555', '998901112233');
  assert.throws(() => ins.run('555', '998907778899'), 'второй активной связки у чата быть не может');

  db.prepare("UPDATE telegram_links SET revoked_at = '2026-08-17T10:00:00Z' WHERE chat_id = '555'").run();
  ins.run('555', '998907778899');   // после «Отвязать» пациент вправе связаться заново
  assert.equal(db.prepare("SELECT COUNT(*) c FROM telegram_links WHERE chat_id='555'").get().c, 2);
  db.close();
});

test('060 отправляет автодокумент один раз, но не ограничивает запросы пациента', () => {
  const db = freshDb();
  const push = db.prepare("INSERT INTO telegram_deliveries (chat_id, doc_kind, doc_ref, trigger) VALUES (?,?,?,'push')");
  push.run('555', 'lab', 'visit_service:42');
  assert.throws(() => push.run('555', 'lab', 'visit_service:42'),
    'перезапуск сервера не должен прислать пациенту тот же анализ повторно');

  const pull = db.prepare("INSERT INTO telegram_deliveries (chat_id, doc_kind, doc_ref, trigger) VALUES (?,?,?,'pull')");
  pull.run('555', 'lab', 'visit_service:42');
  pull.run('555', 'lab', 'visit_service:42');   // запросил дважды — оба раза выдаём
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM telegram_deliveries WHERE trigger='pull'").get().c, 2);
  db.close();
});

test('060 отвергает неизвестный вид документа и неизвестный триггер', () => {
  const db = freshDb();
  assert.throws(() => db.prepare(
    "INSERT INTO telegram_deliveries (chat_id, doc_kind, doc_ref, trigger) VALUES ('1','xray','visit:1','push')").run());
  assert.throws(() => db.prepare(
    "INSERT INTO telegram_deliveries (chat_id, doc_kind, doc_ref, trigger) VALUES ('1','lab','visit:1','guess')").run());
  db.close();
});

test('060 идемпотентна при повторном прогоне мигратора', () => {
  const db = freshDb();
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM telegram_settings').get().c, 1);
  db.close();
});
