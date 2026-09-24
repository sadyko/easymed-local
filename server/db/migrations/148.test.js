// CRM_DEDUP_SEARCH_TASKS_V1 (mig 148) — задачи на карточке заявки CRM.
//
// Форма проверки — та же, что у 142: таблица и её ограничения · реестр (кто
// читает, пишет, удаляет) · индекс под счётчик меню · в другое здание не
// уезжает · повторный накат ничего не ломает. Плюс сами действия экрана
// (создать, отметить, удалить) через компилятор запросов — тот же путь, что у
// /api/db, — и счётчик просроченных для оператора и для администратора.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { canRead, canWrite, writableColumns, readableColumns, filterAllowed } from '../schema-registry.js';
import { compile } from '../query-compiler.js';
import { SHIPPED } from '../../services/branch-sync/journal.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const LOLA  = { id: 2, role: 'callcenter', extra_roles: [] };
const ZARA  = { id: 3, role: 'callcenter', extra_roles: [] };
const REG   = { id: 4, role: 'registrar', extra_roles: [] };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  for (const x of [ADMIN, LOLA, ZARA, REG]) u.run(x.id, 'u' + x.id, 'x', 'Сотрудник ' + x.id, x.role);
  const rid = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, status) VALUES ('Лид','942846494','in_process')").run().lastInsertRowid);
  return { db, rid };
}
const exec = (db, desc, user) => {
  const q = compile(desc, user);
  return desc.op === 'select' ? db.prepare(q.sql).all(...q.params) : db.prepare(q.sql).run(...q.params);
};
const PAST = '2026-09-20T09:00:00Z';
const NOW = '2026-09-23T12:00:00Z';
const FUTURE = '2026-10-01T09:00:00Z';
/** Тот же запрос, что шлёт admin.js за числом в меню (overdueTaskCount). */
const overdue = (db, user, isAdmin) => exec(db, {
  op: 'select', table: 'crm_tasks', columns: 'id',
  filters: [{ col: 'done_at', op: 'is', val: null }, { col: 'due_at', op: 'lte', val: NOW },
    ...(isAdmin ? [] : [{ col: 'assignee_id', op: 'eq', val: user.id }])],
}, user).length;

test('148: crm_tasks — колонки, текст обязателен, задачи уходят вместе с заявкой', () => {
  const { db, rid } = seed();
  try {
    const cols = db.prepare('PRAGMA table_info(crm_tasks)').all().map((c) => c.name);
    assert.deepEqual(cols, ['id', 'request_id', 'text', 'due_at', 'assignee_id', 'done_at', 'done_by', 'created_by', 'created_at']);
    const ins = db.prepare('INSERT INTO crm_tasks (request_id, text, due_at, assignee_id) VALUES (?,?,?,?)');
    assert.throws(() => ins.run(rid, '   ', FUTURE, LOLA.id), /CHECK/i, 'пустая задача записалась');
    assert.throws(() => ins.run(9999, 'x', FUTURE, LOLA.id), /FOREIGN KEY/i, 'задача к несуществующей заявке');
    const tid = ins.run(rid, 'Перезвонить', FUTURE, LOLA.id).lastInsertRowid;
    const row = db.prepare('SELECT done_at, created_at FROM crm_tasks WHERE id = ?').get(tid);
    assert.equal(row.done_at, null, 'новая задача родилась сделанной');
    assert.match(row.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    db.prepare('DELETE FROM crm_requests WHERE id = ?').run(rid);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n, 0, 'задача пережила свою заявку');
  } finally { db.close(); }
});

test('148: реестр — ведут доску три роли, удаляет только администратор, «сделано» при вставке не принимается', () => {
  for (const r of ['admin', 'registrar', 'callcenter']) {
    assert.ok(canRead('crm_tasks', r), r + ' не читает задачи');
    assert.ok(canWrite('crm_tasks', 'insert', r), r + ' не создаёт задачи');
    assert.ok(canWrite('crm_tasks', 'update', r), r + ' не отмечает задачи');
  }
  assert.ok(canWrite('crm_tasks', 'delete', 'admin'));
  for (const r of ['registrar', 'callcenter', 'doctor']) assert.ok(!canWrite('crm_tasks', 'delete', r), r + ' удаляет задачи');
  assert.ok(!canRead('crm_tasks', 'doctor'), 'задачи колл-центра читает врач');
  assert.ok(!writableColumns('crm_tasks', 'insert').includes('done_at'));
  assert.ok(writableColumns('crm_tasks', 'update').includes('done_at'));
  assert.ok(readableColumns('crm_tasks').includes('due_at'));
  for (const f of ['request_id', 'assignee_id', 'done_at', 'due_at']) assert.ok(filterAllowed('crm_tasks', f), 'нет фильтра ' + f);
});

test('148: создать, отметить сделанной, снять отметку, удалить — через /api/db', () => {
  const { db, rid } = seed();
  try {
    const res = exec(db, { op: 'insert', table: 'crm_tasks',
      values: { request_id: rid, text: 'Перезвонить после обеда', due_at: FUTURE, assignee_id: LOLA.id, created_by: LOLA.id } }, LOLA);
    const id = Number(res.lastInsertRowid);
    assert.ok(id > 0);
    // вставить «сразу сделанной» нельзя: компилятор отбрасывает done_at, задача открыта
    const id2 = Number(exec(db, { op: 'insert', table: 'crm_tasks',
      values: { request_id: rid, text: 'x', done_at: NOW } }, LOLA).lastInsertRowid);
    assert.equal(db.prepare('SELECT done_at FROM crm_tasks WHERE id = ?').get(id2).done_at, null);
    db.prepare('DELETE FROM crm_tasks WHERE id = ?').run(id2);

    exec(db, { op: 'update', table: 'crm_tasks', values: { done_at: NOW, done_by: LOLA.id },
      filters: [{ col: 'id', op: 'eq', val: id }] }, LOLA);
    assert.deepEqual({ ...db.prepare('SELECT done_at, done_by FROM crm_tasks WHERE id = ?').get(id) }, { done_at: NOW, done_by: LOLA.id });
    exec(db, { op: 'update', table: 'crm_tasks', values: { done_at: null, done_by: null },
      filters: [{ col: 'id', op: 'eq', val: id }] }, REG);
    assert.equal(db.prepare('SELECT done_at FROM crm_tasks WHERE id = ?').get(id).done_at, null);

    assert.throws(() => exec(db, { op: 'delete', table: 'crm_tasks', filters: [{ col: 'id', op: 'eq', val: id }] }, LOLA),
      'оператор удалил задачу');
    exec(db, { op: 'delete', table: 'crm_tasks', filters: [{ col: 'id', op: 'eq', val: id }] }, ADMIN);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n, 0);
  } finally { db.close(); }
});

test('148: счётчик в меню — оператору свои просроченные, администратору все', () => {
  const { db, rid } = seed();
  try {
    const ins = db.prepare('INSERT INTO crm_tasks (request_id, text, due_at, assignee_id, done_at) VALUES (?,?,?,?,?)');
    ins.run(rid, 'Лоле, просрочена', PAST, LOLA.id, null);
    ins.run(rid, 'Лоле, срок ровно сейчас', NOW, LOLA.id, null);
    ins.run(rid, 'Лоле, будущая', FUTURE, LOLA.id, null);
    ins.run(rid, 'Лоле, просрочена, но сделана', PAST, LOLA.id, NOW);
    ins.run(rid, 'Заре, просрочена', PAST, ZARA.id, null);
    ins.run(rid, 'Ничья, просрочена', PAST, null, null);
    assert.equal(overdue(db, LOLA, false), 2, 'оператору не его число');
    assert.equal(overdue(db, ZARA, false), 1);
    assert.equal(overdue(db, REG, false), 0, 'регистратору без задач — ноль');
    assert.equal(overdue(db, ADMIN, true), 4, 'администратору — все открытые просроченные');

    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM crm_tasks WHERE assignee_id = 2 AND done_at IS NULL AND due_at <= ?")
      .all(NOW).map((r) => r.detail).join(' ');
    assert.match(plan, /idx_crm_tasks_assignee/, 'счётчик меню не берёт индекс: ' + plan);
  } finally { db.close(); }
});

test('148: задачи не уезжают в другое здание', () => {
  assert.ok(!Object.prototype.hasOwnProperty.call(SHIPPED, 'crm_tasks'), 'задачи CRM попали в обмен между зданиями');
  const { db } = seed();
  try {
    const trigs = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='crm_tasks'").all();
    assert.deepEqual(trigs, [], 'у задач появились триггеры обмена: ' + JSON.stringify(trigs));
  } finally { db.close(); }
});

test('148 ложится на базу с заявками и повторный накат ничего не ломает', () => {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig148-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= 148 || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  db.prepare("INSERT INTO crm_requests (id, full_name, phone, status) VALUES (5,'Лид','1','in_process')").run();
  migrate(db);
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 1);
  db.prepare("INSERT INTO crm_tasks (request_id, text) VALUES (5, 'Задача без срока')").run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_crm_tasks_%'").get().n, 2);
  db.close();
});
