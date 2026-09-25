// CRM_HEAD_MERGE_TAGS_V1 (ревью I5) — строки услуг CRM подчиняются видимости
// своей заявки, и присоединённая заявка (embed) — тоже.
//
// До этого оператор через crm_request_services + embed crm_requests(full_name,
// phone, status) перечислял чужие заявки и дописывал строки в чужую заявку.
// Метка «из заявки» на записях календаря, которую видят и те, кто заявок не
// ведёт, переехала на RPC crm_visit_links — только номер визита и заявки.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';
import { compile } from './query-compiler.js';
import { crmVisitLinks } from '../services/rpc/crm-leads.js';
import { getRpc } from '../services/rpc/index.js';
import { isReadOnlyRpc } from '../services/control/gate.js';

const LOLA = { id: 11, role: 'callcenter', extra_roles: [] };
const ZARA = { id: 12, role: 'callcenter', extra_roles: [] };
const REG  = { id: 13, role: 'registrar', extra_roles: [] };
const DOC  = { id: 15, role: 'doctor', extra_roles: [] };
const BOSS = { id: 14, role: 'admin', extra_roles: [] };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  for (const x of [LOLA, ZARA, REG, DOC, BOSS]) u.run(x.id, 'u' + x.id, 'x', 'Сотрудник ' + x.id, x.role);
  db.prepare("INSERT INTO services (id, name, price) VALUES (77, 'Консультация', 1)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3, 'Иванов')").run();
  db.prepare("INSERT INTO visits (id, patient_id, doctor_id, visit_date, status) VALUES (55, 3, 15, '2026-09-30T05:00:00Z', 'confirmed')").run();
  const lead = db.prepare('INSERT INTO crm_requests (id, full_name, phone, status, assigned_to) VALUES (?,?,?,?,?)');
  lead.run(1, 'Лолина', '901', 'in_process', LOLA.id);
  lead.run(2, 'Зарина', '902', 'scheduled', ZARA.id);
  lead.run(3, 'Ничья', '903', 'in_process', null);
  const line = db.prepare("INSERT INTO crm_request_services (id, request_id, service_id, scheduled_date, status, visit_id) VALUES (?,?,77,'2026-09-30','pending',?)");
  line.run(101, 1, null);
  line.run(102, 2, 55);
  line.run(103, 3, null);
  return db;
}
const run = (db, desc, user) => {
  const q = compile(desc, user, { db });
  if (desc.op === 'select') return db.prepare(q.sql).all(...q.params);
  return db.prepare(q.sql).run(...q.params).changes;
};

test('оператор видит строки только своих и ничьих заявок, и embed заявки — только видимой', () => {
  const db = seed();
  try {
    const rows = run(db, { op: 'select', table: 'crm_request_services',
      columns: 'id, request_id, crm_requests(id, full_name, phone, status)', filters: [] }, LOLA);
    assert.deepEqual(rows.map((r) => r.id).sort(), [101, 103], 'оператор перечислил строки чужой заявки');
    assert.ok(!rows.some((r) => r['crm_requests.full_name'] === 'Зарина'), 'имя чужой заявки пришло через embed');
    const all = run(db, { op: 'select', table: 'crm_request_services', columns: 'id, crm_requests(full_name)', filters: [] }, BOSS);
    assert.equal(all.length, 3);
    // Фильтр по колонке родителя через точку — тоже под правилом.
    const byPhone = run(db, { op: 'select', table: 'crm_request_services', columns: 'id',
      filters: [{ col: 'crm_requests.phone', op: 'eq', val: '902' }] }, LOLA);
    assert.deepEqual(byPhone, []);
  } finally { db.close(); }
});

test('embed присоединённой таблицы с владельцем сам несёт её правило (в ON соединения)', () => {
  const db = seed();
  try {
    const q = compile({ op: 'select', table: 'crm_request_services', columns: 'id, crm_requests(full_name)', filters: [] }, LOLA, { db });
    assert.match(q.sql, /LEFT JOIN "crm_requests" AS "crm_requests" ON [^W]*"crm_requests"\."assigned_to" = \?/,
      'соединение с заявкой не ограничено: ' + q.sql);
    // Параметры соединения стоят раньше параметров WHERE.
    assert.equal(q.params[0], LOLA.id);
  } finally { db.close(); }
});

test('вставка и правка строки чужой заявки не проходят; своей — проходят', () => {
  const db = seed();
  try {
    const ins = compile({ op: 'insert', table: 'crm_request_services', values: { request_id: 2, service_id: 77, status: 'pending' } }, LOLA, { db });
    assert.equal(db.prepare(ins.sql).run(...ins.params).changes, 0, 'оператор дописал строку в чужую заявку');
    assert.equal(ins.meta.guarded, true);
    assert.equal(run(db, { op: 'update', table: 'crm_request_services', values: { status: 'cancelled' },
      filters: [{ col: 'id', op: 'eq', val: 102 }] }, LOLA), 0, 'оператор отменил строку чужой заявки');
    assert.equal(run(db, { op: 'update', table: 'crm_request_services', values: { note: 'ok' },
      filters: [{ col: 'id', op: 'eq', val: 101 }] }, LOLA), 1);
    const own = compile({ op: 'insert', table: 'crm_request_services', values: { request_id: 3, service_id: 77, status: 'pending' } }, LOLA, { db });
    assert.equal(db.prepare(own.sql).run(...own.params).changes, 1);
  } finally { db.close(); }
});

test('регистратура: подстановка в смету (заявки пациента → их строки) работает как раньше', () => {
  const db = seed();
  try {
    db.prepare('UPDATE crm_requests SET patient_id = 3 WHERE id IN (1, 3)').run();
    const reqs = run(db, { op: 'select', table: 'crm_requests', columns: 'id', filters: [{ col: 'patient_id', op: 'eq', val: 3 }] }, REG);
    const lines = run(db, { op: 'select', table: 'crm_request_services', columns: 'id, request_id, service_id, scheduled_date, status, doctor_id, visit_id',
      filters: [{ col: 'request_id', op: 'in', val: reqs.map((r) => r.id) }, { col: 'status', op: 'eq', val: 'pending' }] }, REG);
    // Родителей регистратуре отбирает то же правило, что и раньше (своя/ничья):
    // строки видны ровно у тех заявок, которые она и так получала.
    assert.deepEqual(lines.map((l) => l.request_id).sort(), reqs.map((r) => r.id).sort());
  } finally { db.close(); }
});

test('crm_visit_links: номер заявки у записи календаря — и врачу с регистратурой, без содержимого заявки', () => {
  const db = seed();
  try {
    assert.equal(typeof getRpc('crm_visit_links'), 'function');
    assert.equal(isReadOnlyRpc('crm_visit_links'), true);
    for (const who of [DOC, REG, LOLA]) {
      assert.deepEqual(crmVisitLinks(db, { visit_ids: [55, 999] }, who), [{ visit_id: 55, request_id: 2 }],
        'метка «из заявки» пропала у ' + who.role);
    }
    assert.deepEqual(Object.keys(crmVisitLinks(db, { visit_ids: [55] }, DOC)[0]).sort(), ['request_id', 'visit_id']);
    assert.deepEqual(crmVisitLinks(db, { visit_ids: [] }, DOC), []);
    assert.throws(() => crmVisitLinks(db, { visit_ids: [55] }, { id: 99, role: 'kitchen', extra_roles: [] }), (e) => e.status === 403);
  } finally { db.close(); }
});
