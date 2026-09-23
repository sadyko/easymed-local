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

// ---------------------------------------------------------------------------
// crm_search — поиск по всем заявкам, с примерами из базы клиники.
// ---------------------------------------------------------------------------
const search = (db, q, user) => getRpc('crm_search')(db, { q }, user).map((r) => r.full_name);

test('crm_search: номер по цифрам в любом написании — точные случаи из базы', () => {
  const { db, admin } = seed();
  ins(db, { full_name: 'А', phone: '+998 91 566 22 78' });
  ins(db, { full_name: 'Б', phone: '942846494' });
  ins(db, { full_name: 'В', phone: '998904858855' });
  assert.deepEqual(search(db, '915662278', admin), ['А']);
  assert.deepEqual(search(db, '+998915662278', admin), ['А']);
  assert.deepEqual(search(db, '94 284 64 94', admin), ['Б']);
  assert.deepEqual(search(db, '+998904858855', admin), ['В']);
  // часть номера тоже находит
  assert.deepEqual(search(db, '4858', admin), ['В']);
});

test('crm_search: имя без учёта пробелов и регистра, и имя привязанного пациента', () => {
  const { db, admin } = seed();
  ins(db, { full_name: 'Буронова  Феруза', phone: '901111111' });
  const pid = Number(db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Каримова Азиза', '')").run().lastInsertRowid);
  db.prepare("INSERT INTO crm_requests (full_name, phone, source, status, patient_id) VALUES ('+998902222222','+998902222222','call','in_process',?)").run(pid);
  assert.deepEqual(search(db, 'буронова феруза', admin), ['Буронова  Феруза']);
  assert.deepEqual(search(db, 'буроноваферуза', admin), ['Буронова  Феруза']);
  assert.deepEqual(search(db, 'БУРОНОВА', admin), ['Буронова  Феруза']);
  assert.deepEqual(search(db, 'каримова азиза', admin), ['+998902222222']);
});

test('crm_search: находит заявку старше 800 последних и отдаёт форму доски', () => {
  const { db, admin } = seed();
  const old = ins(db, { full_name: 'Старая заявка', phone: '+998 97 700 00 01', created_at: '2025-01-01T10:00:00Z' });
  const tx = db.transaction(() => { for (let i = 0; i < 900; i++) ins(db, { full_name: 'Лид ' + i, phone: String(930000000 + i) }); });
  tx();
  const rows = getRpc('crm_search')(db, { q: 'старая' }, admin);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, old);
  for (const k of ['id', 'full_name', 'phone', 'source', 'status', 'created_at', 'assigned_to', 'patient_id']) {
    assert.ok(k in rows[0], 'нет колонки ' + k);
  }
  assert.ok('patients' in rows[0] && 'users' in rows[0] && 'services' in rows[0], 'нет вложений доски');
  // и не больше 200 на широкий запрос
  assert.equal(getRpc('crm_search')(db, { q: 'лид' }, admin).length, 200);
});

test('crm_search: оператор не находит чужие; одна буква — не поиск', () => {
  const { db, admin, op1, op2 } = seed();
  ins(db, { full_name: 'Чужая Лола', phone: '901234567', assigned_to: op2.id });
  ins(db, { full_name: 'Моя Лола', phone: '901234568', assigned_to: op1.id });
  ins(db, { full_name: 'Ничья Лола', phone: '901234569' });
  assert.deepEqual(search(db, 'лола', op1).sort(), ['Моя Лола', 'Ничья Лола']);
  assert.equal(search(db, 'лола', admin).length, 3);
  assert.deepEqual(search(db, 'л', admin), []);
  assert.deepEqual(search(db, '', admin), []);
  assert.equal(isReadOnlyRpc('crm_search'), true);
});
