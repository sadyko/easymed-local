// CRM_DEDUP_SEARCH_TASKS_V1 — чтение заявок по одному ключу номера.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)');
  const admin = { id: Number(u.run('adm', 'x', 'Админ', 'admin').lastInsertRowid), role: 'admin' };
  const op1 = { id: Number(u.run('op1', 'x', 'Оператор Лола', 'callcenter').lastInsertRowid), role: 'callcenter' };
  const op2 = { id: Number(u.run('op2', 'x', 'Оператор Зарина', 'callcenter').lastInsertRowid), role: 'callcenter' };
  const doc = { id: Number(u.run('doc', 'x', 'Врач', 'doctor').lastInsertRowid), role: 'doctor' };
  const lab = { id: Number(u.run('lab', 'x', 'Лаборант', 'lab').lastInsertRowid), role: 'lab' };
  return { db, admin, op1, op2, doc, lab };
}
const ins = (db, o) => Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, source, status, assigned_to, created_at)
  VALUES (@full_name, @phone, 'call', @status, @assigned_to, @created_at)`).run({
  full_name: 'Лид', status: 'in_process', assigned_to: null, created_at: '2026-09-01T10:00:00Z', ...o }).lastInsertRowid);

test('crm_leads_by_phone: every stage, any stored format, newest first', () => {
  const { db, admin } = seed();
  const a = ins(db, { full_name: 'Старый', phone: '+998 91 566 22 78', status: 'came' });
  const b = ins(db, { full_name: 'Новый', phone: '915662278', status: 'recall' });
  ins(db, { full_name: 'Сосед', phone: '+998915662279' });
  const rows = getRpc('crm_leads_by_phone')(db, { phone: '+998915662278' }, admin);
  assert.deepEqual(rows.map((r) => r.id), [b, a]);
  assert.equal(rows[0].stage_kind, 'open');
  assert.equal(rows[1].stage_kind, 'won');
  assert.ok(rows[1].stage_label, 'нет названия колонки');
  assert.equal(rows[0].can_open, true);
  assert.equal(rows[0].full_name, 'Новый');
});

test('crm_leads_by_phone: nothing for an empty or too-short number, and for a new number', () => {
  const { db, admin } = seed();
  ins(db, { phone: '942846494' });
  const rpc = getRpc('crm_leads_by_phone');
  assert.deepEqual(rpc(db, {}, admin), []);
  assert.deepEqual(rpc(db, { phone: '94' }, admin), []);
  assert.deepEqual(rpc(db, { phone: '+998 90 000 00 00' }, admin), []);
  assert.equal(rpc(db, { phone: '94 284 64 94' }, admin).length, 1);
});

test('crm_leads_by_phone: another operator\'s card is NAMED but not shown or openable', () => {
  const { db, op1, op2 } = seed();
  ins(db, { full_name: 'Каримова', phone: '942846494', assigned_to: op2.id });
  ins(db, { full_name: 'Ничья', phone: '942846494', assigned_to: null });
  ins(db, { full_name: 'Моя', phone: '942846494', assigned_to: op1.id });
  const rows = getRpc('crm_leads_by_phone')(db, { phone: '942846494' }, op1);
  const byName = Object.fromEntries(rows.map((r) => [r.can_open ? r.full_name : 'чужая', r]));
  assert.equal(rows.length, 3);
  assert.equal(byName['Моя'].can_open, true);
  assert.equal(byName['Ничья'].can_open, true);
  assert.equal(byName['чужая'].full_name, '');
  assert.equal(byName['чужая'].phone, '');
  assert.equal(byName['чужая'].assigned_name, 'Оператор Зарина');
});

test('crm_leads_by_phone: only board readers ask, and it is a pure read', () => {
  const { db, doc } = seed();
  // ALL_STAFF читает доску — врач тоже, но результат тот же, что у оператора.
  assert.deepEqual(getRpc('crm_leads_by_phone')(db, { phone: '942846494' }, doc), []);
  assert.throws(() => getRpc('crm_leads_by_phone')(db, { phone: '942846494' }, { id: 99, role: 'nobody' }), /недоступны/);
  assert.equal(isReadOnlyRpc('crm_leads_by_phone'), true);
});
