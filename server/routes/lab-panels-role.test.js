// LAB_PANELS_BY_SECTION_V1 (2026-08-31, owner: «who ever will have permission
// of the lab section will be able to edit the panels») — the server side of
// the rule that panel editing follows LAB-SECTION access, not a Settings grant.
//
// The client's Лаборатория module is visible to the roles whose
// role_permissions row carries the 'labs' section. As shipped (migration 013)
// that set is: admin, doctor, lab, nurse. Panel writes in schema-registry.js
// must equal exactly that set — the door the client shows and the door the
// server opens have to be the same door:
//
//   * a bare 'lab' user (a laborant, ZERO settings-side configuration) edits
//     panels — the owner's acceptance case;
//   * doctor and nurse hold the labs section too, so they may write as well
//     (they could already SEE the queue; now the Панели mode is part of it);
//   * registrar / cashier / inventory / callcenter have no labs section and
//     stay refused with 403 — widening to «everyone» was never asked for.
//
// The write shapes exercised are the editor's own (views/lab-panels.js
// savePanel): insert/update on lab_panels, and the delete-then-insert
// reconcile on lab_panel_analytes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';   // LICENCE_CORE_V1

// Roles whose seeded role_permissions row carries the 'labs' section → may
// write panels. Everyone else in VALID_ROLES must be refused.
const LABS_ROLES = ['admin', 'doctor', 'lab', 'nurse'];
const NO_LABS_ROLES = ['registrar', 'cashier', 'inventory', 'callcenter'];

function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  for (const role of [...LABS_ROLES, ...NO_LABS_ROLES]) {
    db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
      .run('u_' + role, hashPassword('password1'), 'Тест ' + role, role);
  }
  return new Promise((resolve) => {
    const server = createApp(db, { dataDir: licensedDataDir() }).listen(0, '127.0.0.1', () => {
      resolve({ db, server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function login(base, role) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'u_' + role, password: 'password1' }),
  });
  assert.equal(res.status, 200, `login as ${role} failed`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function dbCall(base, cookie, desc) {
  const res = await fetch(base + '/api/db', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(desc),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('a bare lab user edits panels end-to-end: insert, update, analyte reconcile — no settings grant anywhere', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base, 'lab');

  // Create a panel (the editor's «Пустая» path).
  const ins = await dbCall(base, cookie, {
    table: 'lab_panels', op: 'insert', returning: true, single: 'single',
    values: { name: 'Общий анализ крови', modality: 'lab', active: 1 },
  });
  assert.equal(ins.status, 200, 'lab must create a panel: ' + JSON.stringify(ins.json));
  const panelId = ins.json.data.id;

  // Rename it (savePanel's update branch).
  const upd = await dbCall(base, cookie, {
    table: 'lab_panels', op: 'update', values: { name: 'ОАК (развёрнутый)' },
    filters: [{ col: 'id', op: 'eq', val: panelId }],
  });
  assert.equal(upd.status, 200, 'lab must update a panel: ' + JSON.stringify(upd.json));

  // Analyte reconcile = insert new rows, then delete the old ones.
  const aIns = await dbCall(base, cookie, {
    table: 'lab_panel_analytes', op: 'insert', returning: true, single: 'single',
    values: { panel_id: panelId, name: 'Гемоглобин', unit: 'г/л', value_type: 'numeric', decimals: 1, sort_order: 0 },
  });
  assert.equal(aIns.status, 200, 'lab must insert analytes: ' + JSON.stringify(aIns.json));
  const aDel = await dbCall(base, cookie, {
    table: 'lab_panel_analytes', op: 'delete',
    filters: [{ col: 'id', op: 'eq', val: aIns.json.data.id }],
  });
  assert.equal(aDel.status, 200, 'lab must delete analytes (reconcile): ' + JSON.stringify(aDel.json));
});

test('every role with the labs section writes panels; every role without it is refused', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });

  for (const role of LABS_ROLES) {
    const res = await dbCall(base, await login(base, role), {
      table: 'lab_panels', op: 'insert', returning: true, single: 'single',
      values: { name: 'Панель роли ' + role, modality: 'lab', active: 1 },
    });
    assert.equal(res.status, 200, role + ' holds the labs section and must write panels: ' + JSON.stringify(res.json));
  }

  // One login per role, reused for both probes — the per-IP login throttle
  // (routes/auth.js, 10/min) is part of the app under test, not to be tripped.
  for (const role of NO_LABS_ROLES) {
    const cookie = await login(base, role);
    const res = await dbCall(base, cookie, {
      table: 'lab_panels', op: 'insert',
      values: { name: 'Панель роли ' + role, modality: 'lab', active: 1 },
    });
    assert.equal(res.status, 403, role + ' has no labs section and must stay refused');
    const aRes = await dbCall(base, cookie, {
      table: 'lab_panel_analytes', op: 'insert',
      values: { panel_id: 1, name: 'Показатель', value_type: 'numeric', sort_order: 0 },
    });
    assert.equal(aRes.status, 403, role + ' must not write analytes either');
  }
});
