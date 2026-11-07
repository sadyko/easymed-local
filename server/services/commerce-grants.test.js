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

// РЕВЬЮ M1 (2026-11-08) — «НИКТО НИЧЕГО НЕ ПОЛУЧАЕТ» И У АДМИНИСТРАТОРА СО СВОЕЙ
// РОЛЬЮ. Заместитель — своя роль клиники на основе администратора, — которому
// закрыли «Telegram-бот» (или «Настройки» целиком), вчера не рассылал и ссылок
// не правил. Строки commerce_* без точки, раздела у них нет, и «своё „Нет“»
// бота до них не доходило: администратор проходил. Теперь строки идут за ботом.
const DEPUTY = { id: 40, role: 'admin', extra_roles: [], custom_role_code: 'deputy' };
const ADMIN_DOCTOR = { id: 41, role: 'doctor', extra_roles: ['admin'], custom_role_code: 'deputy_doc' };

test('M1: заместитель, закрывший «Telegram-бот», рассылку и ссылки не получает', () => {
  const db = seed();
  try {
    db.prepare('INSERT INTO custom_roles (code, name, base_role, active) VALUES (?,?,?,1)').run('deputy', 'deputy', 'admin');
    db.prepare('INSERT INTO custom_roles (code, name, base_role, active) VALUES (?,?,?,1)').run('deputy_doc', 'deputy_doc', 'doctor');
    for (const [label, grants, push, linksView, linksEdit] of [
      ['бот «Нет»', { 'settings.telegram': 'none' }, false, false, false],
      ['бот «Просмотр»', { 'settings.telegram': 'view' }, false, true, false],
      ['«Настройки: Нет»', { settings: 'none' }, false, false, false],
      ['ничего не записано', {}, true, true, true],
      ['«Настройки: Просмотр», бот не записан', { settings: 'view' }, true, true, true],
      ['бот «Нет», но Push выдан своей строкой', { 'settings.telegram': 'none', commerce_push: 'edit' }, true, false, false],
    ]) {
      setGrants(db, 'deputy', grants);
      setGrants(db, 'deputy_doc', grants);
      for (const who of [DEPUTY, ADMIN_DOCTOR]) {
        const tag = `${who === DEPUTY ? 'заместитель' : 'администратор-врач'}, ${label}`;
        assert.equal(canPush(db, who), push, `${tag}: рассылка`);
        assert.equal(canAdLinks(db, who, 'view'), linksView, `${tag}: ссылки, просмотр`);
        assert.equal(canAdLinks(db, who, 'edit'), linksEdit, `${tag}: ссылки, изменение`);
        if (!push) denied(() => telegramBroadcastSend(db, { text_ru: 'x', confirm_count: 1 }, who));
        if (!linksView) denied(() => telegramDeeplinksList(db, {}, who));
        if (!linksEdit) denied(() => telegramDeeplinkSave(db, {}, who));
      }
      // Экран «Роли» показывает заместителю ровно то же, что дают ворота.
      const lv = effectiveGrantsOf(db, 'deputy');
      assert.equal(lv.commerce_push, push ? 'edit' : 'none', `${label}: экран, Push`);
      assert.equal(lv.commerce_links, linksEdit ? 'edit' : linksView ? 'view' : 'none', `${label}: экран, ссылки`);
    }
  } finally { db.close(); }
});

// РЕВЬЮ M1 — ПРОБА P1 СТАЛА ТЕСТОМ. Те же синтетические роли проходят настоящие
// ворота этого выпуска и правило 3.21.1. Правило 3.21.1 — окно «Telegram-бот»
// (grantAllowsAdminOr по settings.telegram и reports.telegram; этот код с 3.21.1
// не менялся): рассылка — «Изменение»; ссылки — «Просмотр»/«Изменение»; окно
// рассылки — охват бота. Пока роль строк commerce_* не записала, ответ обязан
// совпасть у КАЖДОЙ: никто ничего не теряет и не получает.
test('M1: ни одна роль после обновления не получает и не теряет рассылку и ссылки (проба P1)', async () => {
  const { grantAllowsAdminOr } = await import('./grants.js');
  const { VALID_ROLES } = await import('./roles.js');
  const { telegramBroadcastPreview, telegramBroadcastOptions, telegramBroadcastHistory } = await import('./rpc/telegram.js');
  const { telegramDeeplinkDelete } = await import('./rpc/deeplinks.js');
  const allowed = (fn) => { try { fn(); return true; } catch (e) { return !(e && e.status === 403); } };
  const bot = (db, u, key, need) => grantAllowsAdminOr(db, u, key, need);
  const old = (db, u) => ({
    push_send: bot(db, u, 'settings.telegram', 'edit'),
    push_reach: bot(db, u, 'reports.telegram', 'view') || bot(db, u, 'settings.telegram', 'view'),
    links_view: bot(db, u, 'settings.telegram', 'view'),
    links_edit: bot(db, u, 'settings.telegram', 'edit'),
  });
  const now = (db, u) => ({
    push_send: allowed(() => telegramBroadcastSend(db, {}, u)) && canPush(db, u),
    push_reach: allowed(() => telegramBroadcastPreview(db, { filters: {} }, u))
      && allowed(() => telegramBroadcastOptions(db, {}, u)) && allowed(() => telegramBroadcastHistory(db, {}, u)),
    links_view: allowed(() => telegramDeeplinksList(db, {}, u)) && canAdLinks(db, u, 'view'),
    links_edit: allowed(() => telegramDeeplinkSave(db, {}, u)) && allowed(() => telegramDeeplinkDelete(db, {}, u)) && canAdLinks(db, u, 'edit'),
  });
  const db = seed();
  try {
    for (const base of VALID_ROLES) db.prepare('INSERT INTO custom_roles (code, name, base_role, active) VALUES (?,?,?,1)').run('cx_' + base, 'cx_' + base, base);
    const original = new Map(db.prepare('SELECT role, permissions FROM role_permissions').all().map((r) => [r.role, r.permissions]));
    const put = db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)');
    const restore = () => { for (const [r, p] of original) put.run(r, p); };
    let cases = 0;
    const diffs = [];
    const check = (tag, u) => {
      cases++;
      const o = old(db, u);
      const n = now(db, u);
      for (const k of Object.keys(o)) if (o[k] !== n[k]) diffs.push(`${tag} :: ${k} 3.21.1=${o[k]} сейчас=${n[k]}`);
    };
    for (const tg of [undefined, 'none', 'view', 'edit']) for (const st of [undefined, 'none', 'view']) for (const rt of [undefined, 'view']) for (const chat of [false, true]) {
      const g = {};
      if (tg !== undefined) g['settings.telegram'] = tg;
      if (st !== undefined) g.settings = st;
      if (rt !== undefined) g['reports.telegram'] = rt;
      const p = JSON.stringify({
        sections: ['patients', ...(chat ? ['telegram-chat'] : [])],
        levels: { patients: 'editor', ...(chat ? { 'telegram-chat': 'editor' } : {}) },
        grants: g,
      });
      const tag = `tg=${tg ?? '-'} settings=${st ?? '-'} rep.tg=${rt ?? '-'} chat=${chat ? 'y' : 'n'}`;
      for (const base of VALID_ROLES) {
        restore(); put.run(base, p);
        check(`штатная ${base} | ${tag}`, { id: 9, role: base, extra_roles: [], custom_role_code: null });
        check(`${base}+admin | ${tag}`, { id: 9, role: base, extra_roles: ['admin'], custom_role_code: null });
        check(`${base}+registrar | ${tag}`, { id: 9, role: base, extra_roles: ['registrar'], custom_role_code: null });
        restore(); put.run('cx_' + base, p);
        check(`своя на ${base} | ${tag}`, { id: 9, role: base, extra_roles: [], custom_role_code: 'cx_' + base });
        check(`своя на ${base} + admin | ${tag}`, { id: 9, role: base, extra_roles: ['admin'], custom_role_code: 'cx_' + base });
      }
    }
    restore();
    for (const base of VALID_ROLES) {
      db.prepare('DELETE FROM role_permissions WHERE role = ?').run(base);
      check(`без строки ${base}`, { id: 9, role: base, extra_roles: [], custom_role_code: null });
      restore();
    }
    assert.ok(cases > 2000, `проверено ${cases}`);
    assert.deepEqual(diffs.slice(0, 20), [], `расхождений с 3.21.1: ${diffs.length}`);
  } finally { db.close(); }
});
