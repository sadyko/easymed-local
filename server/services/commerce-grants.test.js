// COMMERCE_BLOCK_V1 (2026-11-07) — «Push-уведомления» и «Ссылки для рекламы»
// получили свои строки в «Ролях». Здесь закреплено главное:
//   1. После обновления никто ничего не теряет и не получает: пока строка не
//      настроена, решает «Telegram-бот», как вчера.
//   2. Строки и вправду разделяют права: рассылку можно выдать без настроек
//      бота, а настройки бота — без рассылки.
//   3. Экран «Роли» видит то же, что ворота (role_effective_grants).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { canPush, canAdLinks } from './commerce-grants.js';
import { effectiveGrantsOf } from './rpc/roles-effective.js';
import { telegramBroadcastSend, telegramSettingsGet } from './rpc/telegram.js';
import { telegramDeeplinksList, telegramDeeplinkSave } from './rpc/deeplinks.js';

const REG = { id: 32, role: 'registrar', extra_roles: [] };
const ADMIN = { id: 1, role: 'admin', extra_roles: [] };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
function setGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = grants;
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
const denied = (fn) => assert.throws(fn, (e) => e && e.status === 403);

test('без своих строк — как вчера: решает «Telegram-бот»', () => {
  const db = seed();
  try {
    assert.equal(canPush(db, REG), false, 'регистратура без бота рассылать не могла');
    assert.equal(canAdLinks(db, REG, 'view'), false);
    setGrants(db, 'registrar', { 'settings.telegram': 'view' });
    assert.equal(canPush(db, REG), false, '«Просмотр» бота рассылку не давал');
    assert.equal(canAdLinks(db, REG, 'view'), true);
    assert.equal(canAdLinks(db, REG, 'edit'), false);
    setGrants(db, 'registrar', { 'settings.telegram': 'edit' });
    assert.equal(canPush(db, REG), true, '«Изменение» бота давало рассылку — и после обновления даёт');
    assert.equal(canAdLinks(db, REG, 'edit'), true);
    assert.equal(canPush(db, ADMIN), true);
    assert.equal(canAdLinks(db, ADMIN, 'edit'), true);
  } finally { db.close(); }
});

test('рассылку можно выдать без настроек бота — и наоборот', () => {
  const db = seed();
  try {
    setGrants(db, 'registrar', { commerce_push: 'edit', commerce_links: 'view' });
    assert.equal(canPush(db, REG), true);
    assert.equal(canAdLinks(db, REG, 'view'), true);
    assert.equal(canAdLinks(db, REG, 'edit'), false);
    denied(() => telegramSettingsGet(db, {}, REG));   // токен и настройки бота — по-прежнему нет
    assert.doesNotThrow(() => telegramDeeplinksList(db, {}, REG));
    denied(() => telegramDeeplinkSave(db, {}, REG));

    // Бот выдан целиком, а рассылка и ссылки — закрыты своими строками.
    setGrants(db, 'registrar', { 'settings.telegram': 'edit', commerce_push: 'none', commerce_links: 'none' });
    assert.equal(canPush(db, REG), false, 'своё «Нет» у рассылки главнее «Telegram-бота»');
    denied(() => telegramBroadcastSend(db, { text_ru: 'x', confirm_count: 1 }, REG));
    denied(() => telegramDeeplinksList(db, {}, REG));
    assert.doesNotThrow(() => telegramSettingsGet(db, {}, REG));
  } finally { db.close(); }
});

test('экран «Роли» видит то же, что ворота', () => {
  const db = seed();
  try {
    let lv = effectiveGrantsOf(db, 'registrar');
    assert.equal(lv.commerce_push, 'none');
    assert.equal(lv.commerce_links, 'none');
    setGrants(db, 'registrar', { 'settings.telegram': 'edit' });
    lv = effectiveGrantsOf(db, 'registrar');
    assert.equal(lv.commerce_push, 'edit', 'незаписанная строка показывает то, что даёт бот');
    assert.equal(lv.commerce_links, 'edit');
    setGrants(db, 'registrar', { 'settings.telegram': 'edit', commerce_push: 'none' });
    assert.equal(effectiveGrantsOf(db, 'registrar').commerce_push, 'none', 'записанное «Нет» — это нет');
    // Разделы со старым ключом в ответ по-прежнему не входят.
    assert.ok(!('patients' in lv) && !('chat' in lv));
  } finally { db.close(); }
});
