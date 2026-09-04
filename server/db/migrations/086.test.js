// 086.test.js — STAFF_SYNC_V1: метка «этого сотрудника завели здесь».
//
// Колонка одна, но от её значения зависит, можно ли править карточку в филиале
// и кого отключит синхронизация. Проверяется здесь то, из-за чего она могла бы
// тихо не работать: умолчание (в главной клинике и в клинике из одного здания
// НИЧЕГО не меняется), запрет третьего значения и — главное — что метка не
// уезжает в выгрузке: у каждой установки на один и тот же вопрос свой ответ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { TABLES } from '../../services/branch-sync/catalogue.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('086: сотрудник, заведённый обычным путём, считается местным', () => {
  const db = fresh();
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('petrov','x','Петров','registrar')").run();
  const row = db.prepare("SELECT is_local FROM users WHERE username = 'petrov'").get();
  assert.equal(row.is_local, 1,
    'умолчание — «завели здесь»: в главной клинике и в клинике из одного здания экран сотрудников работает как работал');
  db.close();
});

test('086: третьего значения не существует — строка не может быть ни местной, ни главной', () => {
  const db = fresh();
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('petrov','x','Петров','registrar')").run();
  assert.throws(() => db.prepare("UPDATE users SET is_local = 2 WHERE username = 'petrov'").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE users SET is_local = NULL WHERE username = 'petrov'").run(), /NOT NULL/);
  db.close();
});

test('086: метка НЕ уезжает соседу — это точка зрения принимающей установки', () => {
  const users = TABLES.find((t) => t.name === 'users');
  assert.ok(users, 'сотрудники обязаны быть в перечне справочника');
  assert.equal(users.columns.includes('is_local'), false,
    'то, что здесь «приехало из главной», у самой главной помечено как местное — колонка описывает установку, а не человека');
  assert.equal(users.localFlag, 'is_local');
});

test('086: колонка есть у users и только у users', () => {
  const db = fresh();
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(cols.includes('is_local'));
  // Права ролей едут тем же каналом, но метки происхождения у них нет намеренно:
  // роли засеяны одинаково в каждой установке, «местной» роли не бывает.
  const rp = db.prepare('PRAGMA table_info(role_permissions)').all().map((c) => c.name);
  assert.equal(rp.includes('is_local'), false);
  db.close();
});
