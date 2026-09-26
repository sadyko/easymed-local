// ROLE_REPORTS_SETTINGS_V1 — «Изменение» плитки настроек — настоящая запись:
// компилятор запросов пускает того, кому окно выдано, и только в таблицы плитки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';
import { compile } from './query-compiler.js';
import { REGISTRY, writeGrantKey } from './schema-registry.js';
import { catalogByKey } from '../../public/js/shared/permission-catalog.js';

const REG = { id: 51, role: 'registrar', extra_roles: [] };
const ADMIN = { id: 1, role: 'admin', extra_roles: [] };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
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
  // Как routes/db.js: компилятор отдаёт SQL, строку вставки читаем по rowid.
  const c = compile(desc, user, { db });
  const r = db.prepare(c.sql).run(...c.params);
  return c.meta.op === 'insert' ? { id: Number(r.lastInsertRowid) } : r;
}
const refused = (e) => e && e.status === 403;

test('регистратура с «Категории пациентов: Изменение» заводит и правит категории', () => {
  const db = seed();
  try {
    addGrants(db, 'registrar', { settings: 'view', 'settings.patient_categories': 'edit' });
    const row = run(db, { table: 'patient_categories', op: 'insert', values: { name: 'VIP' }, returning: true }, REG);
    assert.ok(row && row.id, 'вставка не прошла');
    run(db, { table: 'patient_categories', op: 'update', values: { name: 'VIP-клиенты' }, filters: [{ col: 'id', op: 'eq', val: row.id }] }, REG);
    assert.equal(db.prepare('SELECT name FROM patient_categories WHERE id = ?').get(row.id).name, 'VIP-клиенты');
    // Соседняя таблица той же группы — своя плитка, и она не выдана.
    assert.throws(() => run(db, { table: 'chronic_conditions_ref', op: 'insert', values: { name: 'Астма' } }, REG), refused);
    // Удаления у окон настроек нет вовсе.
    assert.throws(() => compile({ table: 'patient_categories', op: 'delete', filters: [{ col: 'id', op: 'eq', val: row.id }] }, REG, { db }), refused);
  } finally { db.close(); }
});

test('без права — как было: регистратуре 403, администратору можно', () => {
  const db = seed();
  try {
    assert.throws(() => run(db, { table: 'patient_categories', op: 'insert', values: { name: 'X' } }, REG), refused);
    addGrants(db, 'registrar', { settings: 'view', 'settings.patient_categories': 'view' });
    assert.throws(() => run(db, { table: 'patient_categories', op: 'insert', values: { name: 'X' } }, REG), refused, '«Просмотр» разрешил запись');
    assert.ok(run(db, { table: 'patient_categories', op: 'insert', values: { name: 'Y' }, returning: true }, ADMIN).id);
    // Закрытый раздел «Настройки» закрывает и выданное окно.
    addGrants(db, 'registrar', { settings: 'none', 'settings.patient_categories': 'edit' });
    assert.throws(() => run(db, { table: 'patient_categories', op: 'insert', values: { name: 'Z' } }, REG), refused);
  } finally { db.close(); }
});

// ADMIN_ROWS_GRANTABLE_V1 — закрытых строк больше нет, но то, что было их
// смыслом, осталось: без настройки — только администратор, а ключ API создаёт
// только администратор и при выданном «Изменении».
test('бывшие закрытые строки: без настройки — только администратор; ключ API не создаётся и по праву', () => {
  const db = seed();
  try {
    assert.throws(() => compile({ table: 'api_tokens', op: 'select', columns: '*' }, REG, { db }), refused, 'ключи API читаются ненастроенной ролью');
    assert.throws(() => run(db, { table: 'role_permissions', op: 'update', values: { permissions: '{}' }, filters: [{ col: 'role', op: 'eq', val: 'lab' }] }, REG), refused);
    addGrants(db, 'registrar', { settings: 'edit', 'settings.api': 'edit' });
    assert.throws(() => run(db, { table: 'api_tokens', op: 'insert', values: { name: 'k', token: 't' } }, REG), refused);
    assert.ok(compile({ table: 'api_tokens', op: 'select', columns: '*' }, REG, { db }), '«Изменение» ключей не читает список');
  } finally { db.close(); }
});

test('ключ встаёт вместо администратора и не шире: чего не может админ, того не даёт', () => {
  const db = seed();
  try {
    addGrants(db, 'registrar', { settings: 'edit', 'settings.company': 'edit' });
    // doc_settings вставлять не может никто — только править единственную запись.
    assert.throws(() => run(db, { table: 'doc_settings', op: 'insert', values: { clinic_name: 'X' } }, REG), refused);
    run(db, { table: 'doc_settings', op: 'update', values: { clinic_name: 'Клиника' }, filters: [{ col: 'id', op: 'eq', val: 1 }] }, REG);
  } finally { db.close(); }
});

test('прибавка, а не урезание: закрытая плитка источников не отнимает у регистратуры заведение источника', () => {
  const db = seed();
  try {
    addGrants(db, 'registrar', { settings: 'view', 'settings.referral_sources': 'none' });
    assert.ok(run(db, { table: 'referral_sources', op: 'insert', values: { name: 'Доктор Х' }, returning: true }, REG).id);
    assert.throws(() => run(db, { table: 'referral_sources', op: 'update', values: { name: 'Y' }, filters: [{ col: 'id', op: 'eq', val: 1 }] }, REG), refused);
  } finally { db.close(); }
});

test('каждый `write.grant` реестра — живая, не закрытая строка «Настроек» с «Изменением»', () => {
  const byKey = catalogByKey();
  let n = 0;
  for (const t of Object.keys(REGISTRY)) {
    const key = writeGrantKey(t);
    if (!key) continue;
    n++;
    const row = byKey.get(key);
    assert.ok(row, t + ': ключа ' + key + ' нет в справочнике');
    assert.equal(row.parent, 'settings', t + ': ' + key + ' — не окно «Настроек»');
    assert.ok(!row.locked, t + ': ' + key + ' — закрытая строка');
    assert.ok(row.levels.includes('edit'), t + ': у ' + key + ' нет «Изменения»');
    assert.ok(REGISTRY[t].write.insert?.roles?.includes('admin') || REGISTRY[t].write.update?.roles?.includes('admin'), t + ': ключ у таблицы, которую не пишет даже администратор');
  }
  assert.ok(n >= 23, 'таблиц с ключом плитки меньше ожидаемого: ' + n);
  // ADMIN_ROWS_GRANTABLE_V1 — бывшие закрытые строки названы своими таблицами.
  assert.equal(writeGrantKey('api_tokens'), 'settings.api');
  assert.equal(writeGrantKey('role_permissions'), 'settings.roles');
  assert.equal(writeGrantKey('custom_roles'), 'settings.roles');
  for (const t of ['doctor_rates', 'patient_discounts', 'payer_policies', 'payment_providers', 'cashback_rules']) assert.equal(writeGrantKey(t), 'settings.' + t);
  // Ключ у каждой «изменяемой» плитки называет хотя бы одна таблица — иначе
  // «Изменение» на экране было бы галочкой-обманкой.
  const named = new Set(Object.keys(REGISTRY).map(writeGrantKey).filter(Boolean));
  for (const [key, row] of byKey) {
    // ADMIN_ROWS_GRANTABLE_V1 — api: проверяет свой REST-маршрут (routes/users.js),
    // а «Цены и проценты» (`of`) открывают колонки таблиц своей плитки.
    if (row.parent !== 'settings' || !row.levels.includes('edit') || /^(rpc|api):/.test(String(row.enforced))) continue;
    if (row.of) {
      for (const t of Object.keys(row.moneyColumns || {})) assert.equal(writeGrantKey(t), row.of, key + ': деньги таблицы чужой плитки ' + t);
      continue;
    }
    assert.ok(named.has(key), key + ': «Изменение» есть, а таблицы, которую оно открывает, нет');
  }
});

// --- Ревью I2: деньги — только администратору ------------------------------

test('право плитки не пишет денег: переименовать категорию можно, скидку группы — 403', () => {
  const db = seed();
  try {
    addGrants(db, 'registrar', { settings: 'view', 'settings.patient_categories': 'edit', 'settings.rooms': 'edit',
      'settings.referral_sources': 'edit', 'settings.consultation_types': 'edit', 'settings.company': 'edit' });
    const id = run(db, { table: 'patient_categories', op: 'insert', values: { name: 'Льготники' } }, REG).id;
    assert.throws(() => run(db, { table: 'patient_categories', op: 'update', values: { discount_percent: 50 }, filters: [{ col: 'id', op: 'eq', val: id }] }, REG), refused);
    assert.throws(() => run(db, { table: 'patient_categories', op: 'insert', values: { name: 'X', discount_percent: 10 } }, REG), refused);
    assert.throws(() => run(db, { table: 'patient_categories', op: 'upsert', values: { name: 'Y', discount_percent: 10 }, onConflict: 'id' }, REG), refused);
    // Остальные плитки с деньгами — те же правила.
    assert.throws(() => run(db, { table: 'consultation_types', op: 'insert', values: { name: 'Повторная', price: 100 } }, REG), refused);
    assert.ok(run(db, { table: 'consultation_types', op: 'insert', values: { name: 'Повторная' } }, REG).id);
    assert.throws(() => run(db, { table: 'referral_sources', op: 'update', values: { own_percent: 30 }, filters: [{ col: 'id', op: 'eq', val: 1 }] }, REG), refused);
    const w = run(db, { table: 'wards', op: 'insert', values: { name: 'Палата 1' } }, REG).id;
    assert.throws(() => run(db, { table: 'wards', op: 'update', values: { price_per_day: 500000 }, filters: [{ col: 'id', op: 'eq', val: w }] }, REG), refused);
    assert.throws(() => run(db, { table: 'rooms', op: 'insert', values: { name: 'К1', department_id: 1 } }, REG), refused, 'отдел помещения — плитка «Отделы»');
    assert.throws(() => run(db, { table: 'doc_settings', op: 'update', values: { lab_scope: 'own' }, filters: [{ col: 'id', op: 'eq', val: 1 }] }, REG), refused);
    // Администратор пишет деньги как и раньше.
    run(db, { table: 'patient_categories', op: 'update', values: { discount_percent: 50 }, filters: [{ col: 'id', op: 'eq', val: id }] }, ADMIN);
    assert.equal(db.prepare('SELECT discount_percent FROM patient_categories WHERE id = ?').get(id).discount_percent, 50);
  } finally { db.close(); }
});

// ADMIN_ROWS_GRANTABLE_V1 — плитки-деньги выдаются, но пока роль их не
// настраивала, пишет только администратор (как было при закрытых строках).
test('ставки врачей, скидки, полисы, провайдеры и кэшбэк: без настройки — только администратор', () => {
  const db = seed();
  try {
    const money = ['settings.doctor_rates', 'settings.patient_discounts', 'settings.payer_policies', 'settings.payment_providers', 'settings.cashback_rules'];
    const byKey = catalogByKey();
    for (const k of money) assert.ok(byKey.get(k).adminDefault, k + ' открылась бы без настройки');
    addGrants(db, 'registrar', { settings: 'edit' });
    assert.throws(() => run(db, { table: 'doctor_rates', op: 'insert', values: { doctor_id: 1, service_id: 1, percent: 30 } }, REG), refused);
    assert.throws(() => run(db, { table: 'patient_discounts', op: 'insert', values: { name: 'Акция' } }, REG), refused);
    assert.throws(() => run(db, { table: 'payer_policies', op: 'insert', values: { name: 'Полис' } }, REG), refused);
    assert.throws(() => run(db, { table: 'payment_providers', op: 'insert', values: { name: 'Payme' } }, REG), refused);
    assert.throws(() => run(db, { table: 'cashback_rules', op: 'insert', values: { name: 'Кэшбэк' } }, REG), refused);
  } finally { db.close(); }
});

// --- Ревью I1: своя роль на основе администратора слушается своей матрицы ----

test('своя роль на основе администратора: закрытая ею плитка не пишется, хотя основа — admin', () => {
  const db = seed();
  try {
    db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('st_admin', 'Старший администратор', 'admin')").run();
    const BOSS = { id: 60, role: 'admin', extra_roles: [], custom_role_code: 'st_admin' };
    const ADMIN_DOCTOR = { id: 61, role: 'doctor', extra_roles: ['admin'] };
    addGrants(db, 'st_admin', { settings: 'view', 'settings.patient_categories': 'view', 'settings.payers': 'edit' });
    assert.throws(() => run(db, { table: 'patient_categories', op: 'insert', values: { name: 'X' } }, BOSS), refused, '«Просмотр» своей роли не остановил администратора');
    assert.ok(run(db, { table: 'payers', op: 'insert', values: { name: 'Страховая' } }, BOSS).id, 'выданная плитка перестала работать');
    // Ненастроенная этой ролью плитка — как у администратора.
    assert.ok(run(db, { table: 'branches', op: 'insert', values: { name: 'Филиал 2' } }, BOSS).id);
    // Закрытый ею раздел закрывает все плитки.
    addGrants(db, 'st_admin', { settings: 'none' });
    assert.throws(() => run(db, { table: 'branches', op: 'insert', values: { name: 'Филиал 3' } }, BOSS), refused);
    // Штатный администратор и администратор-врач — без изменений, даже если врачам плитку закрыли.
    addGrants(db, 'doctor', { settings: 'none', 'settings.patient_categories': 'none' });
    assert.ok(run(db, { table: 'patient_categories', op: 'insert', values: { name: 'A', discount_percent: 3 } }, ADMIN_DOCTOR).id);
    assert.ok(run(db, { table: 'patient_categories', op: 'insert', values: { name: 'B', discount_percent: 3 } }, ADMIN).id);
  } finally { db.close(); }
});

// --- PACKAGES_V1: пакеты услуг ------------------------------------------------
//
// Регистратура по-прежнему сохраняет смету пакетом (0 %, без дат) и снимает
// пакет из списка — это её рабочий инструмент (реестр, nonAdminColumns). Всё
// остальное — плитка «Пакеты услуг»: «Изменение» пишет название, услуги и
// срок, скидку — только вместе с «Ценами и процентами».
test('пакеты: регистратура сохраняет смету пакетом и снимает его, но скидку и срок — только по праву плитки', () => {
  const db = seed();
  try {
    // Ненастроенная роль: смета → пакет, снять из списка.
    const id = run(db, { table: 'service_templates', op: 'insert', values: { name: 'Смета', service_ids: [1, 2], active: true, company_id: 1 } }, REG).id;
    run(db, { table: 'service_templates', op: 'update', values: { active: false }, filters: [{ col: 'id', op: 'eq', val: id }] }, REG);
    assert.equal(db.prepare('SELECT active FROM service_templates WHERE id = ?').get(id).active, 0);
    // …но не скидку, не срок и не состав готового пакета.
    assert.throws(() => run(db, { table: 'service_templates', op: 'insert', values: { name: 'X', service_ids: [1], discount_percent: 10 } }, REG), refused);
    assert.throws(() => run(db, { table: 'service_templates', op: 'insert', values: { name: 'X', service_ids: [1], valid_until: '2026-12-31' } }, REG), refused);
    assert.throws(() => run(db, { table: 'service_templates', op: 'update', values: { service_ids: [1, 2, 3] }, filters: [{ col: 'id', op: 'eq', val: id }] }, REG), refused);
    assert.throws(() => run(db, { table: 'service_templates', op: 'update', values: { discount_percent: 50 }, filters: [{ col: 'id', op: 'eq', val: id }] }, REG), refused);

    // «Пакеты услуг: Изменение» — название, услуги, срок; скидка — нет.
    addGrants(db, 'registrar', { settings: 'view', 'settings.service_packages': 'edit' });
    run(db, { table: 'service_templates', op: 'update', values: { service_ids: [1, 2, 3], valid_from: '2026-09-01', valid_until: '2026-09-30' }, filters: [{ col: 'id', op: 'eq', val: id }] }, REG);
    assert.equal(db.prepare('SELECT valid_until FROM service_templates WHERE id = ?').get(id).valid_until, '2026-09-30');
    assert.throws(() => run(db, { table: 'service_templates', op: 'update', values: { discount_percent: 50 }, filters: [{ col: 'id', op: 'eq', val: id }] }, REG), refused);
    assert.throws(() => run(db, { table: 'service_templates', op: 'insert', values: { name: 'Y', service_ids: [1], discount_percent: 5 } }, REG), refused);

    // + «Цены и проценты» — и скидка.
    addGrants(db, 'registrar', { 'settings.service_packages.money': 'edit' });
    run(db, { table: 'service_templates', op: 'update', values: { discount_percent: 15 }, filters: [{ col: 'id', op: 'eq', val: id }] }, REG);
    assert.equal(db.prepare('SELECT discount_percent FROM service_templates WHERE id = ?').get(id).discount_percent, 15);
    // «Цены и проценты» без «Изменения» плитки — ничего.
    addGrants(db, 'registrar', { 'settings.service_packages': 'view' });
    assert.throws(() => run(db, { table: 'service_templates', op: 'update', values: { discount_percent: 20 }, filters: [{ col: 'id', op: 'eq', val: id }] }, REG), refused);

    // Администратор пишет всё; кассир и врач — ничего.
    assert.ok(run(db, { table: 'service_templates', op: 'insert', values: { name: 'Акция', service_ids: [1], discount_percent: 10, valid_from: '2026-09-01', valid_until: '2026-09-30' } }, ADMIN).id);
    assert.throws(() => run(db, { table: 'service_templates', op: 'insert', values: { name: 'Z', service_ids: [1] } }, { id: 70, role: 'cashier', extra_roles: [] }), refused);
    assert.throws(() => run(db, { table: 'service_templates', op: 'insert', values: { name: 'Z', service_ids: [1] } }, { id: 71, role: 'doctor', extra_roles: [] }), refused);
  } finally { db.close(); }
});
