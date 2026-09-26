// ADMIN_ROWS_GRANTABLE_V1 (2026-09-26) — бывшие строки «Только администратор»
// выдаются из «Ролей» и проверяются сервером тем же ключом; защиты от
// самоповышения («Роли», «Сотрудники», «API», секреты) — отказом сервера.
//
// Владелец: «there are some roles and functions which are only available to
// the administrator. can you make read, change, delete options for them too?»
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { compile } from '../db/query-compiler.js';
import { hashPassword } from './auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from './control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { telephonySettingsGet, telephonySettingsSave, telephonyProvidersList, telephonyProviderDelete, telephonyForgetBinotel } from './rpc/telephony.js';
import { telegramSettingsGet, telegramSettingsSave, telegramStats, telegramLinksList, telegramLinkRevoke, telegramBroadcastSend } from './rpc/telegram.js';
import { crmConfigGet, crmConfigSave } from './rpc/crm-config.js';
import { requireReportKind } from './report-access.js';
import { catalogRows } from '../../public/js/shared/permission-catalog.js';

const REG = { id: 51, role: 'registrar', extra_roles: [] };
const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const ADMIN_DOCTOR = { id: 2, role: 'doctor', extra_roles: ['admin'] };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, extra_roles) VALUES (?,?,?,?,?,?)');
  ins.run(1, 'boss', hashPassword('password1'), 'Boss', 'admin', '[]');
  ins.run(2, 'docadm', hashPassword('password1'), 'Admin Doctor', 'doctor', '["admin"]');
  ins.run(51, 'reg', hashPassword('password1'), 'Reg', 'registrar', '[]');
  return db;
}
function addGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
function run(db, desc, user) {
  const c = compile(desc, user, { db });
  if (c.meta.op === 'select') return db.prepare(c.sql).all(...c.params);
  const r = db.prepare(c.sql).run(...c.params);
  return c.meta.op === 'insert' ? { id: Number(r.lastInsertRowid) } : r;
}
const refused = (e) => e && e.status === 403;

// --- Справочник ----------------------------------------------------------------

test('закрытых строк больше нет: каждая бывшая — с уровнями и правилом «только администратор»', () => {
  const byKey = new Map(catalogRows().map((r) => [r.key, r]));
  const expect = {
    'reports.telegram': ['none', 'view'],
    'settings.employees': ['none', 'view', 'edit', 'delete'],
    'settings.roles': ['none', 'view', 'edit'],
    'settings.crm': ['none', 'view', 'edit', 'delete'],
    'settings.telephony': ['none', 'view', 'edit', 'delete'],
    'settings.telegram': ['none', 'view', 'edit'],
    'settings.api': ['none', 'view', 'edit'],
    'settings.doctor_rates': ['none', 'view', 'edit'],
    'settings.patient_discounts': ['none', 'view', 'edit'],
    'settings.payer_policies': ['none', 'view', 'edit'],
    'settings.payment_providers': ['none', 'view', 'edit'],
    'settings.cashback_rules': ['none', 'view', 'edit'],
  };
  for (const [k, levels] of Object.entries(expect)) {
    const r = byKey.get(k);
    assert.ok(r, k);
    assert.ok(!r.locked, k + ' всё ещё закрыта');
    assert.ok(r.adminDefault, k + ': без правила «только администратор» строка открылась бы всем после обновления');
    assert.deepEqual(r.levels, levels, k);
  }
  assert.equal(catalogRows().filter((r) => r.locked).length, 0);
  // «Цены и проценты» у каждой плитки, где деньги внутри.
  for (const t of ['service_types', 'consultation_types', 'patient_categories', 'rooms', 'referral_sources', 'referral_source_categories', 'employees']) {
    const m = byKey.get('settings.' + t + '.money');
    assert.ok(m && m.of === 'settings.' + t && m.adminDefault, t + ': нет «Цен и процентов»');
    assert.deepEqual(m.levels, ['none', 'edit']);
  }
});

// --- API-ключи ---------------------------------------------------------------

test('API: нет → 403; просмотр — список без значения ключа; изменение — переименовать и отозвать, но не создать', () => {
  const db = seed();
  try {
    const id = run(db, { table: 'api_tokens', op: 'insert', values: { name: 'Symptex', token: 'emk_secret_value' } }, ADMIN).id;
    // Ненастроенная роль — как вчера.
    assert.throws(() => run(db, { table: 'api_tokens', op: 'select', columns: '*' }, REG), refused);
    addGrants(db, 'registrar', { settings: 'view', 'settings.api': 'none' });
    assert.throws(() => run(db, { table: 'api_tokens', op: 'select', columns: '*' }, REG), refused);
    addGrants(db, 'registrar', { 'settings.api': 'view' });
    const rows = run(db, { table: 'api_tokens', op: 'select', columns: '*' }, REG);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Symptex');
    assert.ok(!JSON.stringify(rows).includes('emk_secret_value'), 'значение ключа ушло к «Просмотру»');
    assert.ok(rows[0].token && rows[0].token !== 'emk_secret_value', 'видно, что ключ есть');
    assert.throws(() => run(db, { table: 'api_tokens', op: 'update', values: { active: 0 }, filters: [{ col: 'id', op: 'eq', val: id }] }, REG), refused);
    addGrants(db, 'registrar', { 'settings.api': 'edit' });
    run(db, { table: 'api_tokens', op: 'update', values: { name: 'Symptex (старый)', active: 0 }, filters: [{ col: 'id', op: 'eq', val: id }] }, REG);
    assert.equal(db.prepare('SELECT active FROM api_tokens WHERE id = ?').get(id).active, 0, 'ключ не отозван');
    // Ключ — полный машинный доступ без областей: создать и задать значение — только администратор.
    assert.throws(() => run(db, { table: 'api_tokens', op: 'insert', values: { name: 'Мой', token: 'x' } }, REG), refused);
    assert.throws(() => run(db, { table: 'api_tokens', op: 'update', values: { token: 'mine' }, filters: [{ col: 'id', op: 'eq', val: id }] }, REG), refused);
    // Администратор видит ключ целиком.
    assert.equal(run(db, { table: 'api_tokens', op: 'select', columns: '*' }, ADMIN)[0].token, 'emk_secret_value');
  } finally { db.close(); }
});

test('API: колонка ключа, спрошенная прямо, тоже замаскирована', () => {
  const db = seed();
  try {
    run(db, { table: 'api_tokens', op: 'insert', values: { name: 'k', token: 'emk_raw' } }, ADMIN);
    addGrants(db, 'registrar', { settings: 'view', 'settings.api': 'edit' });
    const rows = run(db, { table: 'api_tokens', op: 'select', columns: 'id,token' }, REG);
    assert.notEqual(rows[0].token, 'emk_raw');
  } finally { db.close(); }
});

// --- Плитки-деньги и «Цены и проценты» ----------------------------------------

test('плитки-деньги: ненастроенные — только администратор; «Просмотр» не пишет; «Изменение» пишет вместе с процентами', () => {
  const db = seed();
  try {
    const tables = [
      ['payer_policies', 'settings.payer_policies', { name: 'Полис', coverage_percent: 50 }],
      ['payment_providers', 'settings.payment_providers', { name: 'Payme', fee_percent: 1.5 }],
      ['cashback_rules', 'settings.cashback_rules', { name: 'Кэшбэк', percent: 3 }],
      ['patient_discounts', 'settings.patient_discounts', { name: 'Акция', kind: 'promo', percent: 10 }],
      ['doctor_rates', 'settings.doctor_rates', { doctor_id: 2, service_id: null, percent: 30 }],
    ];
    for (const [t, , v] of tables) assert.throws(() => run(db, { table: t, op: 'insert', values: v }, REG), refused, t + ' открылась без настройки');
    addGrants(db, 'registrar', Object.fromEntries([['settings', 'view'], ...tables.map(([, k]) => [k, 'view'])]));
    for (const [t, , v] of tables) assert.throws(() => run(db, { table: t, op: 'insert', values: v }, REG), refused, t + ': «Просмотр» записал');
    addGrants(db, 'registrar', Object.fromEntries(tables.map(([, k]) => [k, 'edit'])));
    for (const [t, , v] of tables) {
      if (t === 'doctor_rates') continue;   // services нет в свежей базе
      assert.ok(run(db, { table: t, op: 'insert', values: v }, REG).id, t + ': «Изменение» не записало');
    }
    // Удаления у этих таблиц нет ни у кого — и «Изменение» его не выдумывает.
    assert.throws(() => compile({ table: 'payer_policies', op: 'delete', filters: [{ col: 'id', op: 'eq', val: 1 }] }, REG, { db }), refused);
  } finally { db.close(); }
});

test('«Цены и проценты»: без действия деньги плитки — 403, с ним — пишутся; без «Изменения» плитки не дают ничего', () => {
  const db = seed();
  try {
    addGrants(db, 'registrar', { settings: 'view', 'settings.patient_categories': 'edit', 'settings.rooms': 'edit' });
    const id = run(db, { table: 'patient_categories', op: 'insert', values: { name: 'Льготники' } }, REG).id;
    assert.throws(() => run(db, { table: 'patient_categories', op: 'update', values: { discount_percent: 20 }, filters: [{ col: 'id', op: 'eq', val: id }] }, REG), refused);
    addGrants(db, 'registrar', { 'settings.patient_categories.money': 'edit', 'settings.rooms.money': 'edit' });
    run(db, { table: 'patient_categories', op: 'update', values: { discount_percent: 20 }, filters: [{ col: 'id', op: 'eq', val: id }] }, REG);
    assert.equal(db.prepare('SELECT discount_percent FROM patient_categories WHERE id = ?').get(id).discount_percent, 20);
    const w = run(db, { table: 'wards', op: 'insert', values: { name: 'Палата 1', price_per_day: 100000 } }, REG).id;
    assert.ok(w);
    // Отдел помещения — не деньги: как и раньше, только администратор.
    assert.throws(() => run(db, { table: 'wards', op: 'update', values: { department_id: 1 }, filters: [{ col: 'id', op: 'eq', val: w }] }, REG), refused);
    // Деньги чужой плитки действие не открывает.
    addGrants(db, 'registrar', { 'settings.consultation_types': 'edit' });
    assert.throws(() => run(db, { table: 'consultation_types', op: 'insert', values: { name: 'Повторная', price: 5 } }, REG), refused);
    // Без «Изменения» плитки действие «Цены и проценты» ничего не пишет.
    addGrants(db, 'registrar', { 'settings.patient_categories': 'view' });
    assert.throws(() => run(db, { table: 'patient_categories', op: 'update', values: { discount_percent: 30 }, filters: [{ col: 'id', op: 'eq', val: id }] }, REG), refused);
  } finally { db.close(); }
});

test('«Помещения: Удаление» удаляет оборудование; «Изменение» — нет', () => {
  const db = seed();
  try {
    const eq = run(db, { table: 'equipment', op: 'insert', values: { name: 'УЗИ' } }, ADMIN).id;
    addGrants(db, 'registrar', { settings: 'view', 'settings.rooms': 'edit' });
    assert.throws(() => compile({ table: 'equipment', op: 'delete', filters: [{ col: 'id', op: 'eq', val: eq }] }, REG, { db }), refused);
    addGrants(db, 'registrar', { 'settings.rooms': 'delete' });
    run(db, { table: 'equipment', op: 'delete', filters: [{ col: 'id', op: 'eq', val: eq }] }, REG);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM equipment WHERE id = ?').get(eq).n, 0);
    // Таблицы плитки, у которых удаления нет ни у кого, «Удаление» не открывает.
    assert.throws(() => compile({ table: 'wards', op: 'delete', filters: [{ col: 'id', op: 'eq', val: 1 }] }, REG, { db }), refused);
  } finally { db.close(); }
});

// --- Телефония ----------------------------------------------------------------

test('телефония: нет → 403; просмотр — без ключа и не сохраняет; изменение — сохраняет, пустой ключ не стирает; удаление — удаляет', () => {
  const db = seed();
  try {
    telephonySettingsSave(db, { api_key: 'binotel-key-123', api_secret: 'super-secret' }, ADMIN);
    const is403 = (e) => e && e.status === 403;
    assert.throws(() => telephonySettingsGet(db, {}, REG), is403, 'ненастроенная роль');
    addGrants(db, 'registrar', { settings: 'view', 'settings.telephony': 'none' });
    assert.throws(() => telephonySettingsGet(db, {}, REG), is403);
    addGrants(db, 'registrar', { 'settings.telephony': 'view' });
    const seen = telephonySettingsGet(db, {}, REG);
    assert.equal(seen.api_key, '', 'ключ Binotel виден на «Просмотре»');
    assert.equal(seen.api_key_set, true);
    assert.ok(!JSON.stringify(seen).includes('binotel-key-123') && !JSON.stringify(seen).includes('super-secret'));
    assert.ok(Array.isArray(telephonyProvidersList(db, {}, REG).providers));
    assert.throws(() => telephonySettingsSave(db, { poll_interval_sec: 60 }, REG), is403);
    addGrants(db, 'registrar', { 'settings.telephony': 'edit' });
    const out = telephonySettingsSave(db, { api_key: '', webhooks_enabled: true }, REG);
    assert.equal(out.api_key, '', 'ключ вернулся в ответе сохранения');
    assert.equal(telephonySettingsGet(db, {}, ADMIN).api_key, 'binotel-key-123', 'пустое поле стёрло ключ');
    telephonySettingsSave(db, { api_key: 'new-key' }, REG);
    assert.equal(telephonySettingsGet(db, {}, ADMIN).api_key, 'new-key', '«Изменение» не может задать новый ключ');
    assert.throws(() => telephonyForgetBinotel(db, {}, REG), is403);
    assert.throws(() => telephonyProviderDelete(db, { id: 1 }, REG), is403);
    addGrants(db, 'registrar', { 'settings.telephony': 'delete' });
    telephonyForgetBinotel(db, {}, REG);
    // Администратор-врач — как администратор, ключ видит.
    telephonySettingsSave(db, { api_key: 'k2', api_secret: 's2' }, ADMIN);
    assert.equal(telephonySettingsGet(db, {}, ADMIN_DOCTOR).api_key, 'k2');
  } finally { db.close(); }
});

// --- Telegram -----------------------------------------------------------------

test('Telegram: настройки — просмотр без токена; отчёт — просмотр охвата; отвязать и разослать — только «Изменение» настроек', async () => {
  const db = seed();
  try {
    db.prepare("UPDATE telegram_settings SET bot_token_hint = 'ab12', bot_token_enc = 'x' WHERE id = 1").run();
    const is403 = (e) => e && e.status === 403;
    for (const fn of [telegramSettingsGet, telegramStats, telegramLinksList]) assert.throws(() => fn(db, {}, REG), is403, 'ненастроенная роль');
    assert.throws(() => requireReportKind(db, REG, 'telegram'), is403);
    addGrants(db, 'registrar', { reports: 'view', 'reports.telegram': 'view' });
    telegramStats(db, {}, REG);
    telegramLinksList(db, {}, REG);
    requireReportKind(db, REG, 'telegram');
    assert.throws(() => telegramSettingsGet(db, {}, REG), is403, 'отчёт открыл настройки бота');
    assert.throws(() => telegramLinkRevoke(db, { id: 1 }, REG), is403);
    assert.throws(() => telegramBroadcastSend(db, { text_ru: 'x' }, REG), is403);
    addGrants(db, 'registrar', { settings: 'view', 'settings.telegram': 'view' });
    const s = telegramSettingsGet(db, {}, REG);
    assert.equal(s.token_hint, '', 'хвост токена виден не-администратору');
    assert.equal(s.has_token, true);
    await assert.rejects(() => telegramSettingsSave(db, { welcome_text: 'Привет' }, REG), is403);
    addGrants(db, 'registrar', { 'settings.telegram': 'edit' });
    const saved = await telegramSettingsSave(db, { welcome_text: 'Привет' }, REG);
    assert.equal(saved.token_hint, '');
    assert.equal(telegramSettingsGet(db, {}, ADMIN).token_hint, 'ab12', 'администратор перестал видеть хвост');
    // «Отчёты: Нет» закрывает и группу Telegram.
    addGrants(db, 'registrar', { reports: 'none', 'settings.telegram': 'none' });
    assert.throws(() => telegramStats(db, {}, REG), is403);
  } finally { db.close(); }
});

// --- CRM-канбан ---------------------------------------------------------------

test('CRM-канбан: нет → 403; изменение — сохраняет без удаления; удалить колонку — только «Удаление», колонку с заявками — никому', () => {
  const db = seed();
  try {
    const is403 = (e) => e && e.status === 403;
    const cfg = crmConfigGet(db);
    const stages = cfg.stages.map((s) => ({ key: s.key, label: s.label, color: s.color, kind: s.kind, is_active: s.is_active }));
    assert.throws(() => crmConfigSave(db, { stages }, REG), is403, 'ненастроенная роль');
    addGrants(db, 'registrar', { settings: 'view', 'settings.crm': 'view' });
    assert.throws(() => crmConfigSave(db, { stages }, REG), is403);
    addGrants(db, 'registrar', { 'settings.crm': 'edit' });
    const renamed = stages.map((s, i) => (i === 0 ? { ...s, label: s.label + ' (новые)' } : s));
    crmConfigSave(db, { stages: [...renamed, { key: 'callback_x', label: 'Перезвонить позже', color: '', kind: 'open', is_active: 1 }] }, REG);
    assert.ok(crmConfigGet(db).stages.some((s) => s.key === 'callback_x'));
    // Убрать колонку из списка — удаление.
    assert.throws(() => crmConfigSave(db, { stages: renamed }, REG), is403);
    addGrants(db, 'registrar', { 'settings.crm': 'delete' });
    crmConfigSave(db, { stages: renamed }, REG);
    assert.ok(!crmConfigGet(db).stages.some((s) => s.key === 'callback_x'));
  } finally { db.close(); }
});

// --- HTTP: «Роли» и «Сотрудники» -------------------------------------------------

async function startServer() {
  const db = seed();
  // HEAD — старшая медсестра клиники: основная роль nurse. Ей выдают «Роли» и «Сотрудников».
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, extra_roles) VALUES (?,?,?,?,?,?)');
  ins.run(60, 'head', hashPassword('password1'), 'Head Nurse', 'nurse', '[]');
  ins.run(61, 'plain', hashPassword('password1'), 'Plain Nurse', 'nurse', '[]');
  ins.run(62, 'cash', hashPassword('password1'), 'Cashier', 'cashier', '[]');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base };
}
async function call(base, method, path, body, cookie) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
async function login(base, username) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }) });
  return res.headers.get('set-cookie').split(';')[0];
}
const perms = (db, role) => JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions);
const saveRole = (base, cookie, role, p) => call(base, 'POST', '/api/db', { table: 'role_permissions', op: 'update', values: { permissions: JSON.stringify(p) }, filters: [{ col: 'role', op: 'eq', val: role }] }, cookie);

test('«Роли»: нет → 403; просмотр → 403 на запись; изменение — правит чужую роль в пределах своих прав', async () => {
  const { db, server, base } = await startServer();
  try {
    const head = await login(base, 'head');
    const lab = perms(db, 'lab');
    const lowered = { ...lab, levels: { ...lab.levels, labs: 'viewer' } };
    assert.equal((await saveRole(base, head, 'lab', lowered)).status, 403, 'ненастроенная роль правит роли');
    addGrants(db, 'nurse', { settings: 'view', 'settings.roles': 'view' });
    assert.equal((await saveRole(base, head, 'lab', lowered)).status, 403, '«Просмотр» правит роли');
    addGrants(db, 'nurse', { 'settings.roles': 'edit' });
    const ok = await saveRole(base, head, 'lab', lowered);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(perms(db, 'lab').levels.labs, 'viewer');
  } finally { server.close(); }
});

test('«Роли»: защита от самоповышения — 403 на каждую попытку', async () => {
  const { db, server, base } = await startServer();
  try {
    addGrants(db, 'nurse', { settings: 'view', 'settings.roles': 'edit' });
    const head = await login(base, 'head');
    const lab = perms(db, 'lab');
    // 1. Выдать больше, чем держишь сам: ключ API у медсестры не выдан.
    let r = await saveRole(base, head, 'lab', { ...lab, grants: { ...lab.grants, 'settings.api': 'edit' } });
    assert.equal(r.status, 403, 'выдала ключ, которого у неё нет');
    // …и поднять ключ, который у неё «Нет».
    r = await saveRole(base, head, 'lab', { ...lab, grants: { ...lab.grants, 'crm.dial': 'edit' } });
    assert.equal(r.status, 403);
    // …и снять явный запрет (возврат к правилу кода — это подъём).
    const noDial = { ...lab.grants }; delete noDial['crm.dial'];
    r = await saveRole(base, head, 'lab', { ...lab, grants: noDial });
    assert.equal(r.status, 403, 'снятый запрет не считался подъёмом');
    // …и раздел, которого у неё нет.
    r = await saveRole(base, head, 'lab', { ...lab, sections: [...lab.sections, 'cashier'], levels: { ...lab.levels, cashier: 'admin' } });
    assert.equal(r.status, 403, 'выдала раздел «Касса», которого у неё нет');
    // 2. Роль администратора.
    r = await saveRole(base, head, 'admin', perms(db, 'admin'));
    assert.equal(r.status, 403, 'правка роли администратора');
    // 3. Своя роль — ни поднять, ни запереть себя.
    const nurse = perms(db, 'nurse');
    r = await saveRole(base, head, 'nurse', { ...nurse, grants: { ...nurse.grants, 'settings.roles': 'none' } });
    assert.equal(r.status, 403, 'правка своей роли');
    // 4. Своя роль клиники на основе администратора — ни завести, ни править.
    r = await call(base, 'POST', '/api/db', { table: 'custom_roles', op: 'insert', values: { code: 'boss2', name: 'Босс', base_role: 'admin', active: 1 } }, head);
    assert.equal(r.status, 403, 'завела роль на основе администратора');
    db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('st_admin', 'Старший администратор', 'admin')").run();
    db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('st_admin', '{\"sections\":[],\"levels\":{}}')").run();
    r = await saveRole(base, head, 'st_admin', { sections: [], levels: {}, grants: { settings: 'none' } });
    assert.equal(r.status, 403, 'правка роли на основе администратора');
    r = await call(base, 'POST', '/api/db', { table: 'custom_roles', op: 'update', values: { name: 'X' }, filters: [{ col: 'code', op: 'eq', val: 'st_admin' }] }, head);
    assert.equal(r.status, 403);
    // 5. Основа своей роли — только та, что носишь сам.
    r = await call(base, 'POST', '/api/db', { table: 'custom_roles', op: 'insert', values: { code: 'st_cash', name: 'Старший кассир', base_role: 'cashier', active: 1 } }, head);
    assert.equal(r.status, 403, 'роль на основе кассира у медсестры');
    r = await call(base, 'POST', '/api/db', { table: 'custom_roles', op: 'insert', values: { code: 'palat', name: 'Палатная', base_role: 'nurse', active: 1 } }, head);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    // Администратор правит всё, как и раньше.
    const boss = await login(base, 'boss');
    r = await saveRole(base, boss, 'lab', { ...lab, grants: { ...lab.grants, 'settings.api': 'edit' } });
    assert.equal(r.status, 200);
  } finally { server.close(); }
});

test('«Сотрудники»: нет → 403; просмотр — список без зарплат и без записи; изменение — заводит; удаление — удаляет', async () => {
  const { db, server, base } = await startServer();
  try {
    const head = await login(base, 'head');
    assert.equal((await call(base, 'GET', '/api/users', undefined, head)).status, 403, 'ненастроенная роль видит сотрудников');
    addGrants(db, 'nurse', { settings: 'view', 'settings.employees': 'view' });
    db.prepare('UPDATE users SET salary_fixed = 7000000 WHERE id = 62').run();
    const list = await call(base, 'GET', '/api/users', undefined, head);
    assert.equal(list.status, 200);
    const cash = list.json.users.find((u) => u.id === 62);
    assert.ok(cash && !('salary_fixed' in cash), 'зарплата видна без «Цен и процентов»');
    assert.equal((await call(base, 'POST', '/api/users', { username: 'new.nurse', password: 'pw', role: 'nurse' }, head)).status, 403, '«Просмотр» заводит сотрудника');
    addGrants(db, 'nurse', { 'settings.employees': 'edit' });
    const created = await call(base, 'POST', '/api/users', { username: 'new.nurse', password: 'pw', role: 'nurse', phone: '+998900000000' }, head);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const nid = created.json.user.id;
    assert.equal((await call(base, 'DELETE', '/api/users/' + nid, undefined, head)).status, 403, '«Изменение» удаляет');
    addGrants(db, 'nurse', { 'settings.employees': 'delete' });
    assert.equal((await call(base, 'DELETE', '/api/users/' + nid, undefined, head)).status, 200);
  } finally { server.close(); }
});

test('«Сотрудники»: защита от самоповышения — 403 на каждую попытку', async () => {
  const { db, server, base } = await startServer();
  try {
    addGrants(db, 'nurse', { settings: 'view', 'settings.employees': 'delete' });
    const head = await login(base, 'head');
    const post = (body) => call(base, 'POST', '/api/users', { password: 'pw', ...body }, head);
    // Администратор — ни основной, ни дополнительной, ни своей ролью на его основе.
    assert.equal((await post({ username: 'evil1', role: 'admin' })).status, 403);
    assert.equal((await post({ username: 'evil2', role: 'nurse', extra_roles: ['admin'] })).status, 403);
    db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('st_admin', 'Старший администратор', 'admin')").run();
    assert.equal((await post({ username: 'evil3', role: 'nurse', custom_role_code: 'st_admin' })).status, 403);
    // Роль, у которой больше прав, чем у назначающего (касса, лаборатория на «Изменении»).
    assert.equal((await post({ username: 'evil4', role: 'cashier' })).status, 403, 'назначила роль выше своей');
    assert.equal((await post({ username: 'evil5', role: 'nurse', extra_roles: ['lab'] })).status, 403);
    // Администратор: ни правки, ни пароля, ни удаления.
    assert.equal((await call(base, 'PATCH', '/api/users/1', { phone: '+998901111111' }, head)).status, 403);
    assert.equal((await call(base, 'PATCH', '/api/users/1', { password: 'hijack' }, head)).status, 403, 'сброс пароля администратору');
    assert.equal((await call(base, 'PATCH', '/api/users/2', { password: 'hijack' }, head)).status, 403, 'сброс пароля администратору-врачу');
    assert.equal((await call(base, 'DELETE', '/api/users/1', undefined, head)).status, 403);
    // Пароль того, чья роль выше, — тоже нет (войти под ним и есть повышение).
    assert.equal((await call(base, 'PATCH', '/api/users/62', { password: 'hijack' }, head)).status, 403);
    // Равному — можно.
    assert.equal((await call(base, 'PATCH', '/api/users/61', { password: 'newpass1' }, head)).status, 200);
    // Свою роль — нельзя; себя удалить — нельзя; своё имя поправить — можно.
    assert.equal((await call(base, 'PATCH', '/api/users/60', { role: 'registrar' }, head)).status, 403);
    assert.equal((await call(base, 'PATCH', '/api/users/60', { extra_roles: ['senior_nurse'] }, head)).status, 403);
    assert.equal((await call(base, 'PATCH', '/api/users/60', { role: 'nurse', phone: '+998902222222' }, head)).status, 200);
    assert.equal((await call(base, 'DELETE', '/api/users/60', undefined, head)).status, 409);
    // Деньги — только с «Цены и проценты».
    assert.equal((await call(base, 'PATCH', '/api/users/61', { salary_fixed: 1 }, head)).status, 403);
    addGrants(db, 'nurse', { 'settings.employees.money': 'edit' });
    assert.equal((await call(base, 'PATCH', '/api/users/61', { salary_fixed: 1 }, head)).status, 200);
    // Администратор — как всегда.
    const boss = await login(base, 'boss');
    assert.equal((await call(base, 'POST', '/api/users', { username: 'second.admin', password: 'pw', role: 'admin' }, boss)).status, 201);
  } finally { server.close(); }
});

test('администратор-врач (admin дополнительной ролью) — «Сотрудники» целиком, как администратор', async () => {
  const { db, server, base } = await startServer();
  try {
    addGrants(db, 'doctor', { settings: 'none', 'settings.employees': 'none' });
    const ad = await login(base, 'docadm');
    const list = await call(base, 'GET', '/api/users', undefined, ad);
    assert.equal(list.status, 200);
    assert.ok(list.json.users.some((u) => 'salary_fixed' in u), 'администратору-врачу урезали зарплаты');
    assert.equal((await call(base, 'POST', '/api/users', { username: 'x.admin', password: 'pw', role: 'admin' }, ad)).status, 201);
  } finally { server.close(); }
});
