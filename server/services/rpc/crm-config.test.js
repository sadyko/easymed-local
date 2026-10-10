// CRM_CONFIG_V1 — the RPC boundary: who may reshape the board, and how a
// refusal reaches the screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { crmConfigGet, crmConfigSave, RpcError } from './crm-config.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc, isAlwaysAllowedRpc } from '../control/gate.js';
import { ensureApiSource } from '../crm/config.js';   // CLINIC_API_STEP7_V1
import { insertConnectionRow } from '../../test-helpers/api-connection-row.js';   // CLINIC_API_STEP7_V1

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
  // CRM_UNIFY_V1 — ОБНОВЛЕНО НАМЕРЕННО: и настройки «CRM-канбан» (crm_settings, мигр. 237).
  assert.deepEqual(Object.keys(out).sort(), ['routing', 'settings', 'sources', 'stages', 'tags']);   // CRM_HEAD_MERGE_TAGS_V1
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

// CRM_UNIFY_V1 — «Колонка записи» и «Колонка конверсии (пришёл)» сохраняются той
// же дверью, что колонки: только администратор (или роль с «CRM-канбан:
// Изменение»), с записью кто и когда.
test('CRM_UNIFY_V1: оператор без права админа не меняет ни колонку записи, ни конверсию', () => {
  const db = fresh();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (4, 'cc', 'x', 'callcenter')").run();
  const operator = { id: 4, role: 'callcenter' };
  for (const user of [operator, registrar]) {
    for (const settings of [{ won_stage: 'approved' }, { booked_stage: 'recall' }]) {
      assert.throws(() => crmConfigSave(db, { settings }, user), (e) => e instanceof RpcError && e.status === 403);
    }
  }
  assert.deepEqual(db.prepare("SELECT key FROM crm_stages WHERE kind = 'won'").all().map((r) => r.key), ['came']);
  assert.deepEqual(db.prepare('SELECT booked_stage, changed_by FROM crm_settings').get(), { booked_stage: null, changed_by: null });
});

test('CRM_UNIFY_V1: администратор переносит конверсию — кто и когда записано; отказ — 400 с фразой', () => {
  const db = fresh();
  const out = crmConfigSave(db, { settings: { won_stage: 'approved', booked_stage: 'scheduled' } }, doctorAdmin);
  assert.equal(out.stages.find((s) => s.kind === 'won').key, 'approved');
  assert.deepEqual(out.settings, { booked_stage: 'scheduled', window_hours: 72, booked_effective: 'scheduled' });
  const row = db.prepare('SELECT changed_by, changed_at FROM crm_settings').get();
  assert.equal(row.changed_by, 2, 'кто менял — тот, кто вошёл, а не то, что прислал браузер');
  assert.ok(row.changed_at);
  // actorId из тела запроса не подменяет вошедшего.
  crmConfigSave(db, { settings: { booked_stage: 'recall' }, actorId: 3 }, admin);
  assert.equal(db.prepare('SELECT changed_by FROM crm_settings').get().changed_by, 1);
  try {
    crmConfigSave(db, { settings: { won_stage: 'stopped' } }, admin);
    assert.fail('ожидался отказ');
  } catch (e) {
    assert.ok(e instanceof RpcError);
    assert.equal(e.status, 400);
    assert.match(e.message, /Проигрышная колонка/);
  }
});

test('CLINIC_API_STEP7_V1: «CRM-канбан: Изменение» без «Удаления» сохраняет список без источника подключения — это не удаление', () => {
  const db = fresh();
  db.prepare('INSERT INTO custom_roles (code, name, base_role) VALUES (?, ?, ?)').run('crm_edit', 'crm_edit', 'registrar');
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('crm_edit',
    JSON.stringify({ sections: ['settings'], levels: {}, grants: { settings: 'view', 'settings.crm': 'edit' } }));
  const editor = { id: 3, role: 'registrar', extra_roles: [], custom_role_code: 'crm_edit' };
  const { key } = ensureApiSource(db, { kind: 'partner', name: 'med24.uz' });
  insertConnectionRow(db, { crm_source_key: key });
  const sent = crmConfigGet(db).sources.filter((s) => s.key !== key).map((s) => ({ key: s.key, label: s.label, is_active: s.is_active }));
  assert.ok(crmConfigSave(db, { sources: sent }, editor).sources.some((s) => s.key === key));
  // Настоящее удаление по-прежнему требует «Удаления».
  assert.throws(() => crmConfigSave(db, { sources: sent.filter((s) => s.key !== 'other') }, editor), (e) => e.status === 403);
});

// CLINIC_API_STEP7_V1 (ревью №7) — на границе RPC отказ остаётся 409 и едет шаблоном
// (экран переводит), а не превращается в «Источники сохранены».
test('CLINIC_API_STEP7_V1: новый источник с кодом подключения — RpcError 409 с шаблоном', () => {
  const db = fresh();
  const { key } = ensureApiSource(db, { kind: 'symptex', name: 'Symptex' });
  insertConnectionRow(db, { kind: 'symptex', name: 'Symptex', crm_source_key: key });
  const sent = crmConfigGet(db).sources.filter((s) => !(s.api && s.api.owned)).map((s) => ({ key: s.key, label: s.label, is_active: s.is_active }));
  try {
    crmConfigSave(db, { sources: [...sent, { key, label: 'API Symptex', is_active: true }] }, admin);
    assert.fail('сохранение прошло');
  } catch (e) {
    assert.ok(e instanceof RpcError);
    assert.equal(e.status, 409);
    assert.ok(e.template && e.params && e.params.key === key);
  }
});
