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
    const row = run(db, { table: 'patient_categories', op: 'insert', values: { name: 'VIP', discount_percent: 5 }, returning: true }, REG);
    assert.ok(row && row.id, 'вставка не прошла');
    run(db, { table: 'patient_categories', op: 'update', values: { discount_percent: 7 }, filters: [{ col: 'id', op: 'eq', val: row.id }] }, REG);
    assert.equal(db.prepare('SELECT discount_percent FROM patient_categories WHERE id = ?').get(row.id).discount_percent, 7);
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

test('закрытые строки выдать нельзя: ключ, записанный руками, сервер не читает', () => {
  const db = seed();
  try {
    addGrants(db, 'registrar', {
      settings: 'edit', 'settings.api': 'edit', 'settings.roles': 'edit', 'settings.telegram': 'edit',
      'settings.telephony': 'edit', 'settings.crm': 'edit',
    });
    assert.throws(() => run(db, { table: 'api_tokens', op: 'insert', values: { name: 'k', token: 't' } }, REG), refused);
    assert.throws(() => compile({ table: 'api_tokens', op: 'select', columns: '*' }, REG, { db }), refused, 'ключи API читаются не администратором');
    assert.throws(() => run(db, { table: 'role_permissions', op: 'update', values: { permissions: '{}' }, filters: [{ col: 'role', op: 'eq', val: 'registrar' }] }, REG), refused);
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
  assert.ok(n >= 20, 'таблиц с ключом плитки меньше ожидаемого: ' + n);
  // Ни одна закрытая строка не названа ни одной таблицей.
  for (const t of Object.keys(REGISTRY)) assert.notEqual(writeGrantKey(t), 'settings.api');
  assert.equal(writeGrantKey('api_tokens'), null);
  assert.equal(writeGrantKey('role_permissions'), null);
  // Ключ у каждой «изменяемой» плитки называет хотя бы одна таблица — иначе
  // «Изменение» на экране было бы галочкой-обманкой.
  const named = new Set(Object.keys(REGISTRY).map(writeGrantKey).filter(Boolean));
  for (const [key, row] of byKey) {
    if (row.parent !== 'settings' || !row.levels.includes('edit') || String(row.enforced).startsWith('rpc:')) continue;
    assert.ok(named.has(key), key + ': «Изменение» есть, а таблицы, которую оно открывает, нет');
  }
});
