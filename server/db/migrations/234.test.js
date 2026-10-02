// JOURNALS_V1_WARD_CLASS (мигр. 234) — класс палаты: Люкс / Полулюкс / Обычная.
//
// Колонка добавляется (ADD COLUMN), таблица НЕ пересобирается (урок 1.1.0):
// на wards ссылаются койки, госпитализации, переводы и план этажа. Пусто —
// класс не задан. Проверяется на базе С ДАННЫМИ.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { compile } from '../query-compiler.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { readableColumns, writableColumns } from '../schema-registry.js';
import { catalogByKey } from '../../../public/js/shared/permission-catalog.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = '234_ward_class.sql';
const SQL = fs.readFileSync(path.join(DIR, FILE), 'utf8');
const CODE = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

function dbBefore234() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig234-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 234)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

test('234: только ADD COLUMN — палаты, койки и госпитализации на месте, класс пуст', () => {
  const db = dbBefore234();
  try {
    const w = db.prepare("INSERT INTO wards (name, type, price_per_day) VALUES ('Палата 1', 'general', 250000)").run().lastInsertRowid;
    const b = db.prepare("INSERT INTO beds (code, ward_id) VALUES ('1-1', ?)").run(w).lastInsertRowid;
    db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'P-1', 'Пациент')").run();
    db.prepare("INSERT INTO admissions (patient_id, bed_id, ward_id, status) VALUES (1, ?, ?, 'active')").run(b, w);
    const before = db.prepare('SELECT * FROM wards ORDER BY id').all();
    migrate(db);
    const after = db.prepare('SELECT * FROM wards ORDER BY id').all();
    assert.deepEqual(after.map(({ ward_class, ...rest }) => rest), before, 'миграция тронула что-то кроме ward_class');
    assert.deepEqual(after.map((r) => r.ward_class), [null], 'класс по умолчанию не задан');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM admissions WHERE ward_id = ? AND bed_id = ?').get(w, b).n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check(beds)').all(), []);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check(admissions)').all(), []);
    assert.match(CODE.trim(), /^ALTER TABLE wards ADD COLUMN ward_class TEXT CHECK \(ward_class IN \('lux', 'semi_lux', 'standard'\)\);$/);
    const col = db.prepare("SELECT type, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('wards') WHERE name = 'ward_class'").get();
    assert.deepEqual(col, { type: 'TEXT', nn: 0, d: null });
  } finally { db.close(); }
});

test('234: CHECK — только lux / semi_lux / standard или пусто', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const ins = db.prepare('INSERT INTO wards (name, ward_class) VALUES (?, ?)');
    for (const v of ['lux', 'semi_lux', 'standard', null]) assert.doesNotThrow(() => ins.run('Палата ' + v, v), String(v));
    for (const v of ['vip', 'Люкс', '', 'LUX']) assert.throws(() => ins.run('Палата ' + v, v), /CHECK/, String(v));
  } finally { db.close(); }
});

test('234: повторный migrate ничего не меняет и не падает', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.prepare("INSERT INTO wards (name, ward_class) VALUES ('Люкс-1', 'lux')").run();
    const snap = db.prepare('SELECT id, name, ward_class FROM wards ORDER BY id').all();
    migrate(db);
    assert.deepEqual(db.prepare('SELECT id, name, ward_class FROM wards ORDER BY id').all(), snap);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE name = ?').get(FILE).n, 1);
  } finally { db.close(); }
});

test('234: реестр и «Помещения: Изменение» — класс читают все, пишет право плитки; цена — по-прежнему деньги', () => {
  assert.ok(readableColumns('wards').includes('ward_class'));
  assert.ok(writableColumns('wards', 'insert').includes('ward_class'));
  assert.ok(writableColumns('wards', 'update').includes('ward_class'));
  assert.ok(catalogByKey().get('settings.rooms').grantColumns.wards.includes('ward_class'), 'класс — не деньги');
  const db = openDb(':memory:');
  try {
    migrate(db);
    const REG = { id: 51, role: 'registrar', extra_roles: [] };
    const row = db.prepare("SELECT permissions FROM role_permissions WHERE role = 'registrar'").get();
    const perms = JSON.parse(row.permissions);
    perms.grants = { ...(perms.grants || {}), settings: 'view', 'settings.rooms': 'edit' };
    db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'registrar'").run(JSON.stringify(perms));
    const w = db.prepare("INSERT INTO wards (name) VALUES ('Палата 5')").run().lastInsertRowid;
    const run = (values) => {
      const c = compile({ table: 'wards', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: w }] }, REG, { db });
      return db.prepare(c.sql).run(...c.params);
    };
    run({ ward_class: 'semi_lux' });
    assert.equal(db.prepare('SELECT ward_class FROM wards WHERE id = ?').get(w).ward_class, 'semi_lux');
    run({ ward_class: null });
    assert.equal(db.prepare('SELECT ward_class FROM wards WHERE id = ?').get(w).ward_class, null);
    assert.throws(() => run({ ward_class: 'vip' }), /CHECK/);
    assert.throws(() => run({ price_per_day: 1 }), (e) => e && e.status === 403, 'цена палаты открылась без «Цен и процентов»');
  } finally { db.close(); }
});
