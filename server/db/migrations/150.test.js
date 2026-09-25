// CRM_HEAD_MERGE_TAGS_V1 (mig 150) — метки на карточках заявок CRM.
//
// Форма проверки — та же, что у 148: таблицы и их ограничения · реестр (кто
// читает, ставит, снимает) · ограничение через заявку (чужие метки не видны,
// на чужую заявку не поставить; руководителю колл-центра — всё) · в другое
// здание не уезжает · повторный накат ничего не ломает.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { canRead, canWrite, filterAllowed, readableColumns } from '../schema-registry.js';
import { compile } from '../query-compiler.js';
import { SHIPPED } from '../../services/branch-sync/journal.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const LOLA  = { id: 2, role: 'callcenter', extra_roles: [] };
const ZARA  = { id: 3, role: 'callcenter', extra_roles: [] };
const HEAD  = { id: 4, role: 'callcenter', extra_roles: [], custom_role_code: 'head_cc' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, custom_role_code) VALUES (?,?,?,?,?,?)');
  for (const x of [ADMIN, LOLA, ZARA, HEAD]) u.run(x.id, 'u' + x.id, 'x', 'Сотрудник ' + x.id, x.role, x.custom_role_code || null);
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
    .run('head_cc', JSON.stringify({ sections: ['crm'], levels: {}, grants: { 'crm.all': 'edit' } }));
  db.prepare("INSERT INTO crm_tags (key, label, color, position) VALUES ('vip','VIP','purple',1), ('repeat','Повторный','teal',2)").run();
  const lead = db.prepare('INSERT INTO crm_requests (id, full_name, phone, status, assigned_to) VALUES (?,?,?,?,?)');
  lead.run(10, 'Лолина', '901', 'in_process', LOLA.id);
  lead.run(11, 'Зарина', '902', 'in_process', ZARA.id);
  lead.run(12, 'Ничья', '903', 'in_process', null);
  return db;
}
const exec = (db, desc, user) => {
  const q = compile(desc, user, { db });
  if (desc.op === 'select') return db.prepare(q.sql).all(...q.params);
  if (q.statements) return db.transaction(() => q.statements.reduce((n, st) => n + db.prepare(st.sql).run(...st.params).changes, 0))();
  return db.prepare(q.sql).run(...q.params).changes;
};
const tagsOn = (db, rid) => db.prepare('SELECT tag_key FROM crm_request_tags WHERE request_id = ? ORDER BY tag_key').all(rid).map((r) => r.tag_key);

test('150: crm_tags и crm_request_tags — колонки и ограничения', () => {
  const db = seed();
  try {
    assert.deepEqual(db.prepare('PRAGMA table_info(crm_tags)').all().map((c) => c.name), ['key', 'label', 'color', 'position', 'is_active']);
    assert.deepEqual(db.prepare('PRAGMA table_info(crm_request_tags)').all().map((c) => c.name), ['request_id', 'tag_key']);
    const ins = db.prepare('INSERT INTO crm_tags (key, label, color) VALUES (?,?,?)');
    assert.throws(() => ins.run('Bad Key', 'x', ''), /CHECK/i, 'ключ с пробелом и заглавной записался');
    assert.throws(() => ins.run('ok_key', '  ', ''), /CHECK/i, 'метка без названия');
    assert.throws(() => ins.run('ok_key', 'Метка', '#ff0000'), /CHECK/i, 'свободный цвет вместо токена');
    ins.run('ok_key', 'Метка', '');

    const link = db.prepare('INSERT INTO crm_request_tags (request_id, tag_key) VALUES (?,?)');
    link.run(10, 'vip');
    assert.throws(() => link.run(10, 'vip'), /UNIQUE|PRIMARY/i, 'одна метка дважды на одной заявке');
    assert.throws(() => link.run(10, 'nope'), /FOREIGN KEY/i, 'метка, которой нет в справочнике');
    assert.throws(() => link.run(999, 'vip'), /FOREIGN KEY/i, 'метка на несуществующей заявке');
    assert.throws(() => db.prepare("DELETE FROM crm_tags WHERE key = 'vip'").run(), /FOREIGN KEY/i, 'метку со всех карточек сняло удаление справочника');
    db.prepare('DELETE FROM crm_requests WHERE id = 10').run();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_request_tags').get().n, 0, 'метки пережили свою заявку');
  } finally { db.close(); }
});

test('150: реестр — справочник читают все и не пишет никто; метки ставят и снимают три роли доски', () => {
  for (const r of ['admin', 'registrar', 'callcenter', 'doctor']) assert.ok(canRead('crm_tags', r), r + ' не читает справочник меток');
  for (const op of ['insert', 'update', 'delete']) assert.ok(!canWrite('crm_tags', op, 'admin'), 'справочник меток пишется мимо crm_config_save: ' + op);
  for (const r of ['admin', 'registrar', 'callcenter']) {
    assert.ok(canWrite('crm_request_tags', 'insert', r), r + ' не ставит метку');
    assert.ok(canWrite('crm_request_tags', 'delete', r), r + ' не снимает метку');
  }
  assert.ok(!canWrite('crm_request_tags', 'update', 'admin'), 'у связи нечего править');
  assert.ok(!canWrite('crm_request_tags', 'insert', 'doctor'));
  assert.deepEqual(readableColumns('crm_request_tags'), ['request_id', 'tag_key']);
  for (const f of ['request_id', 'tag_key']) assert.ok(filterAllowed('crm_request_tags', f));
});

test('150: метки подчиняются видимости заявки — оператору свои и ничьи, руководителю всё', () => {
  const db = seed();
  try {
    const put = db.prepare('INSERT INTO crm_request_tags (request_id, tag_key) VALUES (?,?)');
    put.run(10, 'vip'); put.run(11, 'vip'); put.run(12, 'repeat');
    const SEL = { op: 'select', table: 'crm_request_tags', columns: 'request_id, tag_key', filters: [] };
    const ids = (user) => exec(db, SEL, user).map((r) => r.request_id).sort();
    assert.deepEqual(ids(LOLA), [10, 12], 'оператору видны метки чужой заявки');
    assert.deepEqual(ids(ADMIN), [10, 11, 12]);
    assert.deepEqual(ids(HEAD), [10, 11, 12], 'руководитель колл-центра не видит меток всей доски');

    // Поставить на свою — можно, на чужую — нет (пакет откатывается целиком).
    assert.equal(exec(db, { op: 'insert', table: 'crm_request_tags', values: [{ request_id: 10, tag_key: 'repeat' }] }, LOLA), 1);
    assert.deepEqual(tagsOn(db, 10), ['repeat', 'vip']);
    const q = compile({ op: 'insert', table: 'crm_request_tags', values: { request_id: 11, tag_key: 'repeat' } }, LOLA, { db });
    assert.equal(db.prepare(q.sql).run(...q.params).changes, 0, 'оператор поставил метку на чужую заявку');
    assert.equal(exec(db, { op: 'insert', table: 'crm_request_tags', values: [{ request_id: 11, tag_key: 'repeat' }] }, HEAD), 1);

    // Снять с чужой — ничего не снимается; руководитель — снимает.
    assert.equal(exec(db, { op: 'delete', table: 'crm_request_tags', filters: [{ col: 'request_id', op: 'eq', val: 11 }, { col: 'tag_key', op: 'in', val: ['vip'] }] }, LOLA), 0);
    assert.equal(exec(db, { op: 'delete', table: 'crm_request_tags', filters: [{ col: 'request_id', op: 'eq', val: 11 }, { col: 'tag_key', op: 'in', val: ['vip'] }] }, HEAD), 1);
    assert.deepEqual(tagsOn(db, 11), ['repeat']);
  } finally { db.close(); }
});

test('150: метки не уезжают в другое здание', () => {
  for (const t of ['crm_tags', 'crm_request_tags']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(SHIPPED, t), t + ' попала в обмен между зданиями');
  }
  const db = openDb(':memory:');
  try {
    migrate(db);
    const trigs = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('crm_tags','crm_request_tags')").all();
    assert.deepEqual(trigs, []);
  } finally { db.close(); }
});

test('150 ложится на базу с заявками и повторный накат ничего не ломает', () => {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig150-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= 150 || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  db.prepare("INSERT INTO crm_requests (id, full_name, phone, status) VALUES (5,'Лид','1','in_process')").run();
  migrate(db);
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_tags').get().n, 0, 'миграция завела клинике метки, которых она не просила');
  db.prepare("INSERT INTO crm_tags (key, label) VALUES ('x', 'Икс')").run();
  db.prepare("INSERT INTO crm_request_tags (request_id, tag_key) VALUES (5, 'x')").run();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name = 'idx_crm_request_tags_tag'").get().n, 1);
  db.close();
});
