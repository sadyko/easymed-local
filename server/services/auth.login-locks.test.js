// STAFF_EDIT_V1 (2026-11-02) — НОВЫЙ ПАРОЛЬ СНИМАЕТ БЛОКИРОВКУ ВХОДА.
//
// Пять неверных паролей запирают вход «логин + адрес» на 5 минут
// (services/auth.js login). Сотрудник, забывший пароль, просил администратора
// сбросить его — и с НОВЫМ паролем получал «Слишком много попыток»: блокировка
// переживала сброс. Теперь любая установка пароля (сброс администратором и своя
// смена) снимает блокировку этого логина со всех адресов: clearLoginLocks.
// Карта блокировок — в памяти процесса и общая для файла: у тестов свои логины.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { login, hashPassword, changeOwnPassword, clearLoginLocks } from './auth.js';

function dbWith(...names) {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)');
  for (const n of names) ins.run(n, hashPassword('secret123'), n, 'nurse');
  return db;
}
const lock = (db, name, ip) => { for (let i = 0; i < 5; i += 1) login(db, name, 'bad', { ip }); };

test('clearLoginLocks снимает блокировку логина со всех адресов и не трогает чужие', () => {
  const db = dbWith('lk.alpha', 'lk.beta');
  lock(db, 'lk.alpha', '10.0.0.1');
  lock(db, 'lk.alpha', '10.0.0.2');
  lock(db, 'lk.beta', '10.0.0.1');
  assert.equal(login(db, 'lk.alpha', 'secret123', { ip: '10.0.0.1' }).error, 'locked');
  assert.equal(clearLoginLocks(' LK.Alpha '), 2, 'по записи блокировки на каждый адрес');
  assert.ok(login(db, 'lk.alpha', 'secret123', { ip: '10.0.0.1' }).session, 'с первого адреса вход открыт');
  assert.ok(login(db, 'lk.alpha', 'secret123', { ip: '10.0.0.2' }).session, 'со второго — тоже');
  assert.equal(login(db, 'lk.beta', 'secret123', { ip: '10.0.0.1' }).error, 'locked', 'чужая блокировка снята');
  assert.equal(clearLoginLocks(''), 0);
  assert.equal(clearLoginLocks(null), 0);
});

test('своя смена пароля снимает блокировку входа', () => {
  const db = dbWith('lk.self');
  const { id } = db.prepare("SELECT id FROM users WHERE username = 'lk.self'").get();
  lock(db, 'lk.self', '10.0.0.3');
  assert.equal(login(db, 'lk.self', 'secret123', { ip: '10.0.0.3' }).error, 'locked');
  assert.deepEqual(changeOwnPassword(db, id, 'secret123', 'fresh1'), { ok: true });
  assert.ok(login(db, 'lk.self', 'fresh1', { ip: '10.0.0.3' }).session, 'новый пароль не впустили — блокировка пережила смену');
});
