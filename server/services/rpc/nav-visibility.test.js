// NAV_VISIBILITY_V1 — RPC видимости разделов: читают все, меняет администратор, «Настройки» не прячутся.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { navVisibilityGet, navVisibilitySave, RpcError } from './nav-visibility.js';
import { getRpc } from './index.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin'); ins.run(2, 'reg', 'x', 'registrar'); ins.run(3, 'docadm', 'x', 'doctor');
  return db;
}
const admin = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
const doctorAdmin = { id: 3, role: 'doctor', extra_roles: ['admin'] };

test('регистрация RPC; чтение — любому вошедшему, по умолчанию пусто; без пользователя — 401', () => {
  const db = fresh();
  assert.equal(typeof getRpc('nav_visibility_get'), 'function');
  assert.equal(typeof getRpc('nav_visibility_save'), 'function');
  assert.deepEqual(navVisibilityGet(db, {}, registrar), { hidden: [] });
  assert.throws(() => navVisibilityGet(db, {}, null), (e) => e instanceof RpcError && e.status === 401);
});

test('сохранение — администратор (и дополнительной ролью тоже); список заменяется целиком и нормализуется', () => {
  const db = fresh();
  assert.throws(() => navVisibilitySave(db, { hidden: ['crm'] }, registrar), (e) => e.status === 403);
  assert.deepEqual(navVisibilitySave(db, { hidden: ['telegram-chat', 'crm', 'crm'] }, doctorAdmin), { hidden: ['crm', 'telegram-chat'] });
  assert.deepEqual(navVisibilityGet(db, {}, registrar), { hidden: ['crm', 'telegram-chat'] }, 'регистратор видит, что скрыто, — его меню от этого зависит');
  assert.equal(db.prepare("SELECT hidden_by FROM nav_visibility WHERE nav_id = 'crm'").get().hidden_by, 3);
  assert.deepEqual(navVisibilitySave(db, { hidden: ['admissions'] }, admin), { hidden: ['admissions'] });
  assert.deepEqual(navVisibilityGet(db, {}, admin), { hidden: ['admissions'] }, 'прежние строки ушли — список заменён');
  assert.deepEqual(navVisibilitySave(db, { hidden: [] }, admin), { hidden: [] });
});

test('«Настройки» скрыть нельзя; мусор в списке — отказ 400, ничего не меняется', () => {
  const db = fresh();
  navVisibilitySave(db, { hidden: ['crm'] }, admin);
  assert.throws(() => navVisibilitySave(db, { hidden: ['crm', 'settings'] }, admin), (e) => e.status === 400 && /Настройки/.test(e.message));
  assert.throws(() => navVisibilitySave(db, { hidden: ['crm', 'DROP TABLE'] }, admin), (e) => e.status === 400);
  assert.throws(() => navVisibilitySave(db, { hidden: 'crm' }, admin), (e) => e.status === 400);
  assert.throws(() => navVisibilitySave(db, {}, admin), (e) => e.status === 400);
  assert.deepEqual(navVisibilityGet(db, {}, admin), { hidden: ['crm'] });
});
