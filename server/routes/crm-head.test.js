// CRM_HEAD_MERGE_TAGS_V1 (2026-09-25) — «РУКОВОДИТЕЛЬ КОЛЛ-ЦЕНТРА» ГАЛОЧКОЙ.
//
// Владелец: галочка в «Ролях» «Видит все заявки и передаёт их» (`crm.all`) для
// любой роли клиники. Держатель видит все карточки, передаёт их, видит
// показатели операторов и просроченные задачи всей команды; удалять карточки —
// только администратор.
//
// Проверяется НАСТОЯЩАЯ дверь: /api/db через приложение (маршрут обязан
// передать компилятору базу, иначе право не прочитается), плюс RPC поиска,
// проверки дубля и показателей звонков. Своя роль клиники «Руководитель
// колл-центра» стоит на основе `callcenter` — так её заводит экран «Роли».

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { compile } from '../db/query-compiler.js';
import { crmSearch, crmLeadsByPhone } from '../services/rpc/crm-leads.js';
import { telephonyOperatorStats } from '../services/rpc/telephony.js';
import { canSeeAllLeads } from '../services/crm/visibility.js';
import { catalogRows } from '../../public/js/shared/permission-catalog.js';
import { getRpc } from '../services/rpc/index.js';

const OP_A = { id: 21, role: 'callcenter', extra_roles: [] };
const OP_B = { id: 22, role: 'callcenter', extra_roles: [] };
const HEAD = { id: 24, role: 'callcenter', extra_roles: [], custom_role_code: 'head_cc' };
const BOSS = { id: 23, role: 'admin', extra_roles: [] };
const DAY = { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' };

function setGrants(db, role, grants) {
  const perms = { sections: ['crm'], levels: { crm: 'editor' }, grants };
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET permissions = excluded.permissions')
    .run(role, JSON.stringify(perms));
}

function seed({ grant = 'edit' } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, custom_role_code) VALUES (?,?,?,?,?,?)');
  u.run(21, 'opa', hashPassword('password1'), 'Оператор А', 'callcenter', null);
  u.run(22, 'opb', hashPassword('password1'), 'Оператор Б', 'callcenter', null);
  u.run(23, 'boss', hashPassword('password1'), 'Админ', 'admin', null);
  u.run(24, 'head', hashPassword('password1'), 'Руководитель', 'callcenter', 'head_cc');
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('head_cc', 'Руководитель колл-центра', 'callcenter')").run();
  if (grant) setGrants(db, 'head_cc', { 'crm.all': grant });
  const lead = db.prepare('INSERT INTO crm_requests (id, full_name, phone, status, assigned_to) VALUES (?,?,?,?,?)');
  lead.run(1, 'Заявка А', '+998 90 111 11 11', 'in_process', 21);
  lead.run(2, 'Ничья', '902222222', 'in_process', null);
  lead.run(3, 'Заявка Б', '903333333', 'in_process', 22);
  const t = db.prepare('INSERT INTO crm_tasks (id, request_id, text, due_at, assignee_id) VALUES (?,?,?,?,?)');
  t.run(10, 1, 'Перезвонить А', '2026-01-01T09:00:00Z', 21);
  t.run(11, 3, 'Перезвонить Б', '2026-01-01T09:00:00Z', 22);
  db.prepare("INSERT INTO calls (general_call_id, started_at, internal_number, external_number, billsec) VALUES ('1','2026-09-20T08:00:00Z','101','998901111111',42)").run();
  return db;
}

async function start(opts) {
  const db = seed(opts);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}
async function login(base, who) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: who, password: 'password1' }),
  });
  assert.equal(res.status, 200, 'login ' + who);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
async function dbCall(base, cookie, desc) {
  const res = await fetch(base + '/api/db', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(desc),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const ids = (r) => (r.json.data || []).map((x) => x.id).sort((a, b) => a - b);

test('справочник: строка crm.all — действие раздела CRM, «Нет»/«Изменение», проверка названа и зарегистрирована', () => {
  const row = catalogRows().find((r) => r.key === 'crm.all');
  assert.ok(row, 'в справочнике нет строки «Видит все заявки и передаёт их»');
  assert.equal(row.parent, 'crm');
  assert.equal(row.kind, 'action');
  assert.deepEqual(row.levels, ['none', 'edit']);
  assert.match(row.enforced, /^rpc:/);
  assert.equal(typeof getRpc(row.enforced.slice(4)), 'function', 'проверка названа, а RPC нет: ' + row.enforced);
});

test('руководитель с crm.all через /api/db видит, правит и передаёт чужую заявку и её задачи; удалить не может', async () => {
  const { db, server, base } = await start();
  try {
    const head = await login(base, 'head');
    const all = await dbCall(base, head, { table: 'crm_requests', op: 'select', columns: 'id', filters: [] });
    assert.equal(all.status, 200);
    assert.deepEqual(ids(all), [1, 2, 3], 'руководитель видит не всю доску');

    const tasks = await dbCall(base, head, { table: 'crm_tasks', op: 'select', columns: 'id', filters: [] });
    assert.deepEqual(ids(tasks), [10, 11], 'задачи чужих заявок руководителю не видны');

    // Передать заявку Б оператору А.
    const pass = await dbCall(base, head, { table: 'crm_requests', op: 'update', values: { assigned_to: 21, note: 'передал' },
      filters: [{ col: 'id', op: 'eq', val: 3 }] });
    assert.equal(pass.status, 200);
    assert.equal(db.prepare('SELECT assigned_to FROM crm_requests WHERE id = 3').get().assigned_to, 21, 'заявка не передалась');

    // Задачу чужой заявки — переназначить.
    const tk = await dbCall(base, head, { table: 'crm_tasks', op: 'update', values: { assignee_id: 24 },
      filters: [{ col: 'id', op: 'eq', val: 10 }] });
    assert.equal(tk.status, 200);
    assert.equal(db.prepare('SELECT assignee_id FROM crm_tasks WHERE id = 10').get().assignee_id, 24);

    // Вставить задачу на чужую заявку — можно (родитель виден).
    const ins = await dbCall(base, head, { table: 'crm_tasks', op: 'insert', values: { request_id: 1, text: 'Проверить' } });
    assert.equal(ins.status, 200, JSON.stringify(ins.json));

    // Удалять — только администратор.
    const del = await dbCall(base, head, { table: 'crm_requests', op: 'delete', filters: [{ col: 'id', op: 'eq', val: 1 }] });
    assert.equal(del.status, 403, 'руководитель удалил заявку');
    const delT = await dbCall(base, head, { table: 'crm_tasks', op: 'delete', filters: [{ col: 'id', op: 'eq', val: 10 }] });
    assert.equal(delT.status, 403, 'руководитель удалил задачу');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 3);
  } finally { server.close(); db.close(); }
});

test('без права — как было: своя и ничьи, чужую не передать', async () => {
  const { db, server, base } = await start({ grant: 'none' });
  try {
    const head = await login(base, 'head');
    const all = await dbCall(base, head, { table: 'crm_requests', op: 'select', columns: 'id', filters: [] });
    assert.deepEqual(ids(all), [2], 'без crm.all видно больше своих и ничьих');
    await dbCall(base, head, { table: 'crm_requests', op: 'update', values: { assigned_to: 24 },
      filters: [{ col: 'id', op: 'eq', val: 3 }] });
    assert.equal(db.prepare('SELECT assigned_to FROM crm_requests WHERE id = 3').get().assigned_to, 22, 'чужую заявку забрали без права');

    const opa = await login(base, 'opa');
    assert.deepEqual(ids(await dbCall(base, opa, { table: 'crm_requests', op: 'select', columns: 'id', filters: [] })), [1, 2]);
  } finally { server.close(); db.close(); }
});

test('роль без строки crm.all (не настроена) — прежнее правило; администратор видит всё', () => {
  const db = seed({ grant: null });
  try {
    assert.equal(canSeeAllLeads(db, HEAD), false, 'ненастроенный ключ открыл доску');
    assert.equal(canSeeAllLeads(db, OP_A), false);
    assert.equal(canSeeAllLeads(db, BOSS), true);
    assert.equal(canSeeAllLeads(db, { id: 30, role: 'doctor', extra_roles: ['admin'] }), true, 'администратор-врач потерял доску');
    // Компилятор без базы — самый узкий доступ даже у держателя права.
    setGrants(db, 'head_cc', { 'crm.all': 'edit' });
    const q = compile({ table: 'crm_requests', op: 'select', columns: 'id', filters: [] }, HEAD);
    assert.deepEqual(db.prepare(q.sql).all(...q.params).map((r) => r.id), [2]);
    const q2 = compile({ table: 'crm_requests', op: 'select', columns: 'id', filters: [] }, HEAD, { db });
    assert.deepEqual(db.prepare(q2.sql).all(...q2.params).map((r) => r.id).sort(), [1, 2, 3]);
  } finally { db.close(); }
});

test('закрытый раздел CRM закрывает и crm.all', () => {
  const db = seed();
  try {
    db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?')
      .run(JSON.stringify({ sections: [], levels: {}, grants: { crm: 'none', 'crm.all': 'edit' } }), 'head_cc');
    assert.equal(canSeeAllLeads(db, HEAD), false);
  } finally { db.close(); }
});

test('поиск и проверка дубля: руководитель находит чужие карточки, оператор — нет', () => {
  const db = seed();
  try {
    assert.deepEqual(crmSearch(db, { q: '903333333' }, HEAD).map((r) => r.id), [3]);
    assert.deepEqual(crmSearch(db, { q: '903333333' }, OP_A), [], 'оператор нашёл чужую заявку');
    const dup = crmLeadsByPhone(db, { phone: '901111111' }, HEAD);
    assert.equal(dup.length, 1);
    assert.equal(dup[0].id, 1, 'руководителю отдали только факт «есть у другого оператора»');
    const dupB = crmLeadsByPhone(db, { phone: '901111111' }, OP_B);
    assert.deepEqual(dupB, [{ can_open: false, foreign: true }]);
  } finally { db.close(); }
});

test('показатели звонков по операторам: администратор и руководитель — да, оператор и роль без права — нет', () => {
  const db = seed();
  try {
    assert.equal(telephonyOperatorStats(db, DAY, BOSS).length, 1);
    assert.equal(telephonyOperatorStats(db, DAY, HEAD).length, 1, 'руководитель не видит звонков операторов');
    assert.throws(() => telephonyOperatorStats(db, DAY, OP_A), (e) => e.status === 403);
    setGrants(db, 'head_cc', { 'crm.all': 'none' });
    assert.throws(() => telephonyOperatorStats(db, DAY, HEAD), (e) => e.status === 403);
  } finally { db.close(); }
});
