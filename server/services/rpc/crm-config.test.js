// CRM_CONFIG_V1 — the RPC boundary: who may reshape the board, and how a
// refusal reaches the screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { crmConfigGet, crmConfigSave, RpcError } from './crm-config.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc, isAlwaysAllowedRpc } from '../control/gate.js';

const fresh = () => {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin');
  ins.run(2, 'docadm', 'x', 'doctor');
  ins.run(3, 'reg', 'x', 'registrar');
  return db;
};
const admin = { id: 1, role: 'admin' };
// ADMIN_DOCTOR_V1's shape: primary role doctor, admin as an extra.
const doctorAdmin = { id: 2, role: 'doctor', extra_roles: ['admin'] };
const registrar = { id: 3, role: 'registrar' };

test('crm_config_get answers stages, sources and routing in one call', () => {
  const db = fresh();
  const out = crmConfigGet(db, {}, registrar);
  assert.deepEqual(Object.keys(out).sort(), ['routing', 'sources', 'stages']);
  assert.equal(out.stages.length, 8);
  assert.equal(out.sources.length, 8);
  assert.equal(out.routing.length, 15);
});

test('crm_config_get is open to every logged-in member of staff', () => {
  const db = fresh();
  // It is the vocabulary the kanban is DRAWN from. An operator who could see
  // the cards but not their column headings would be looking at a broken
  // screen, and crm_requests itself is ALL_STAFF.
  for (const user of [registrar, doctorAdmin, admin]) {
    assert.equal(crmConfigGet(db, {}, user).stages.length, 8);
  }
});

test('crm_config_save is admin-only, counting extra roles', () => {
  const db = fresh();
  assert.throws(() => crmConfigSave(db, { sources: [] }, registrar),
    (e) => e instanceof RpcError && e.status === 403);
  // The role check runs BEFORE validation: a registrar must be told "not you",
  // not "your list is empty".
  const out = crmConfigSave(db, {}, doctorAdmin);
  assert.equal(out.stages.length, 8);
});

test('a guard refusal surfaces as its own status and sentence, not a 500', () => {
  const db = fresh();
  db.prepare("INSERT INTO crm_requests (full_name, status) VALUES ('Заявка','no_show')").run();
  const without = crmConfigGet(db, {}, admin).stages.filter((s) => s.key !== 'no_show');
  try {
    crmConfigSave(db, { stages: without }, admin);
    assert.fail('ожидался отказ');
  } catch (e) {
    assert.ok(e instanceof RpcError);
    // 409, not 400: the screen distinguishes «нельзя, потому что занято»
    // (предложить «скрыть») from «вы что-то заполнили неверно».
    assert.equal(e.status, 409);
    assert.match(e.message, /скрыть|удалить/);
  }
  assert.equal(crmConfigGet(db, {}, admin).stages.length, 8);
});

test('crm_config_save applies the whole screen and answers with the whole config', () => {
  const db = fresh();
  const stages = crmConfigGet(db, {}, admin).stages.map((s) => ({ ...s }));
  stages.push({ key: 'waiting_pay', label: 'Ждёт оплаты', color: 'warn', kind: 'open' });
  const out = crmConfigSave(db, {
    stages,
    sources: [...crmConfigGet(db, {}, admin).sources, { key: 'billboard', label: 'Билборд' }],
    routing: [{ disposition: 'ANSWER', action: 'create', stage_key: 'waiting_pay' }],
  }, admin);
  assert.equal(out.stages.length, 9);
  assert.equal(out.sources.length, 9);
  assert.equal(out.routing.find((r) => r.disposition === 'ANSWER').stage_key, 'waiting_pay');
});

test('both names are registered in the RPC map', () => {
  assert.equal(typeof getRpc('crm_config_get'), 'function');
  assert.equal(typeof getRpc('crm_config_save'), 'function');
});

test('the gate classifies them: get reads, save writes, neither is always-allowed', () => {
  // READ_ONLY fails closed by default (gate.js), so a read RPC left out of the
  // set silently stops working during a licence lapse — the board would lose
  // its column headings on exactly the day the clinic is most anxious.
  assert.equal(isReadOnlyRpc('crm_config_get'), true);
  assert.equal(isReadOnlyRpc('crm_config_save'), false);
  // Reshaping the CRM board is clinical operations, not licence recovery.
  assert.equal(isAlwaysAllowedRpc('crm_config_get'), false);
  assert.equal(isAlwaysAllowedRpc('crm_config_save'), false);
});
