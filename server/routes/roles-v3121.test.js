// V3121_ROLES — роли, сохранённые до 3.12, продолжают работать.
//
// После 3.12.0 разбор всех ролей клиники (штатные, пересохранённые на старых
// экранах «Роли», и свои роли клиники) нашёл места, где 3.12 стал проверять то,
// чего старые роли не могли выставить осмысленно, или сузил доступ так, что
// ломалась обычная работа. Каждый тест — одно такое место, настоящим
// HTTP-запросом через createApp.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const USERS = [
  ['admin', 'admin', 0], ['doctor', 'doctor', 1], ['doctor2', 'doctor', 1], ['nurse', 'nurse', 0],
  ['lab', 'lab', 0], ['registrar', 'registrar', 0],
];

async function withServer(t) {
  const db = openDb(':memory:');
  migrate(db);
  const pw = hashPassword('password1');
  const ids = {};
  for (const [u, role, isDoc] of USERS) {
    ids[u] = Number(db.prepare('INSERT INTO users (username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?)')
      .run(u, pw, 'Сотрудник ' + u, role, isDoc).lastInsertRowid);
  }
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); });
  const cookie = {};
  for (const [u] of USERS) {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: 'password1' }) });
    assert.equal(res.status, 200, 'login ' + u);
    cookie[u] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  return { db, ids, base, cookie };
}

async function rpc(ctx, who, name, args) {
  const res = await fetch(ctx.base + '/api/rpc/' + name, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie[who] }, body: JSON.stringify(args) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function seedLine(db, performerId) {
  const pid = Number(db.prepare("INSERT INTO patients (mrn, full_name) VALUES (?, 'Каримов Азиз')")
    .run('P-' + Math.random().toString(36).slice(2, 8)).lastInsertRowid);
  const sid = Number(db.prepare("INSERT INTO services (name, price, type) VALUES ('Массаж спины', 100000, 'procedure')").run().lastInsertRowid);
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-09-28T09:00:00Z')").run(pid).lastInsertRowid);
  const vsid = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?,?,?,1,100000,100000,'in_progress')")
    .run(vid, sid, performerId).lastInsertRowid);
  return { pid, vid, vsid };
}

// ---------------------------------------------------------------------------
// Подпись протокола в кабинете (visit_document_archive).
//
// До 3.12 кабинет писал протокол прямо в visit_documents, и вставку делала
// любая роль с правом вставки — в том числе медсестра, которой клиника дала
// «Кабинет врача» для её собственных процедур (исполнитель строки — она). 3.12
// перевёл подпись на RPC только для врачей: у такой медсестры протокол молча
// перестал сохраняться (кабинет пишет отказ лишь в консоль).
// ---------------------------------------------------------------------------
test('V3121_ROLES: медсестра — исполнитель строки — подписывает протокол своей процедуры', async (t) => {
  const ctx = await withServer(t);
  const { vsid, pid } = seedLine(ctx.db, ctx.ids.nurse);
  const r = await rpc(ctx, 'nurse', 'visit_document_archive', { visit_service_id: vsid, doc_type: 'protocol', title: 'Протокол процедуры', body: { v: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = ctx.db.prepare('SELECT created_by, patient_id, voided_at FROM visit_documents WHERE visit_service_id = ?').get(vsid);
  assert.equal(row.created_by, ctx.ids.nurse);
  assert.equal(row.patient_id, pid);
  assert.equal(row.voided_at, null);
});

test('V3121_ROLES: лаборант — исполнитель строки — подписывает протокол своего исследования', async (t) => {
  const ctx = await withServer(t);
  const { vsid } = seedLine(ctx.db, ctx.ids.lab);
  const r = await rpc(ctx, 'lab', 'visit_document_archive', { visit_service_id: vsid, doc_type: 'protocol', title: 'Протокол', body: { v: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('V3121_ROLES: медсестра подписывает строку без исполнителя, как до 3.12', async (t) => {
  const ctx = await withServer(t);
  const { vsid } = seedLine(ctx.db, null);
  const r = await rpc(ctx, 'nurse', 'visit_document_archive', { visit_service_id: vsid, doc_type: 'protocol', title: 'Протокол', body: { v: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('V3121_ROLES: чужую строку не подписывают ни медсестра, ни лаборант, ни регистратура', async (t) => {
  const ctx = await withServer(t);
  const { vsid } = seedLine(ctx.db, ctx.ids.doctor2);
  for (const who of ['nurse', 'lab', 'registrar', 'doctor']) {
    const r = await rpc(ctx, who, 'visit_document_archive', { visit_service_id: vsid, doc_type: 'protocol', title: 'x', body: {} });
    assert.equal(r.status, 403, who + ' ' + JSON.stringify(r.json));
  }
  const free = seedLine(ctx.db, null);
  const r = await rpc(ctx, 'registrar', 'visit_document_archive', { visit_service_id: free.vsid, doc_type: 'protocol', title: 'x', body: {} });
  assert.equal(r.status, 403, 'регистратура протоколов не подписывает');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM visit_documents').get().n, 0);
});
