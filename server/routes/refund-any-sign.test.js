// REFUND_ANY_V1 (2026-10-29) — ВОЗВРАЩЁННАЯ УСЛУГА: НОВЫЙ ДОКУМЕНТ ВРАЧА НЕ ПОДПИСЫВАЕТСЯ.
//
// Подпись заключения идёт табличным путём (/api/db): подписанная версия
// (kind 'signed') в visit_services.notes, документ врача — в visit_documents.
// За строку пациенту вернули деньги (pay_refund_releases 'out', строка без
// счёта) — новая или изменённая подпись и новый документ врача — 409
// refunded_line; черновик — можно; прежние документы остаются. Строка, которую
// выставили заново, — как обычно.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { notesBaseOf, NOTES_BASE_KEY } from '../services/domain/cabinet-notes.js';
import { REFUNDED_SIGN_REFUSAL } from '../../public/js/shared/refunded-line.js';

const DOC = 3;
const NOTES = (history) => JSON.stringify({ __service_workspace_v1: 1, current: { chief_complaint: 'Кашель' }, history });
const SIGNED = { kind: 'signed', savedAt: '2026-10-02T08:00:00.000Z', by: DOC, byName: 'Иванова А.', fields: { chief_complaint: 'Кашель' } };
const SIGNED_NEW = { kind: 'signed', savedAt: '2026-10-29T09:00:00.000Z', by: DOC, byName: 'Иванова А.', fields: { chief_complaint: 'Кашель, итог' } };
const DRAFT = { kind: 'draft', savedAt: '2026-10-29T08:30:00.000Z', fields: { chief_complaint: 'Кашель, правка' }, tab: 't1' };

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, extra_roles, is_doctor, is_active, must_change_password)
              VALUES (?, 'doc', ?, 'Иванова А.', 'doctor', '[]', 1, 1, 0)`).run(DOC, hashPassword('password1'));
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Пациент')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (1, 'Консультация', 100000, 'consultation')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1, 1, '2026-10-29T07:00:00Z', 'arrived')").run();
  const line = db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, notes)
                           VALUES (?, 1, 1, ?, 1, 100000, 100000, 'in_progress', ?)`);
  line.run(1, DOC, NOTES([SIGNED]));   // за неё вернули деньги
  line.run(2, DOC, NOTES([SIGNED]));   // обычная
  db.prepare("INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out', 1, 1)").run();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}
async function login(base) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'doc', password: 'password1' }) });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
async function call(base, cookie, path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('возвращённая строка: новая и изменённая подпись — 409 refunded_line; черновик — можно; обычная строка подписывается', async () => {
  const { db, server, base } = await startServer();
  try {
    const notesOf = (id) => db.prepare('SELECT notes FROM visit_services WHERE id = ?').get(id).notes;
    const write = (cookie, id, history) => call(base, cookie, '/api/db', { table: 'visit_services', op: 'update',
      values: { notes: NOTES(history), [NOTES_BASE_KEY]: notesBaseOf(notesOf(id)) }, filters: [{ col: 'id', op: 'eq', val: id }] });
    const doc = await login(base);
    const before = notesOf(1);
    let r = await write(doc, 1, [SIGNED, SIGNED_NEW]);
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.deepEqual([r.json.error.code, r.json.error.message], ['refunded_line', REFUNDED_SIGN_REFUSAL]);
    r = await write(doc, 1, [{ ...SIGNED, fields: { chief_complaint: 'Кашель, переписано' } }]);
    assert.equal(r.status, 409, 'изменённая подписанная версия — тоже новая подпись');
    assert.equal(notesOf(1), before, 'документ не тронут');
    r = await write(doc, 1, [SIGNED, DRAFT]);
    assert.equal(r.status, 200, 'черновик — не подпись. ' + JSON.stringify(r.json));
    r = await write(doc, 2, [SIGNED, SIGNED_NEW]);
    assert.equal(r.status, 200, 'обычная строка подписывается. ' + JSON.stringify(r.json));
    // Выставили заново (отметка снята) — подписывается.
    db.prepare("DELETE FROM pay_refund_releases WHERE kind = 'out' AND line_id = 1").run();
    r = await write(doc, 1, [SIGNED, DRAFT, SIGNED_NEW]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
  } finally { server.close(); }
});

test('возвращённая строка: новый документ врача в visit_documents и копия подписанного — 409; у обычной строки — пишутся', async () => {
  const { db, server, base } = await startServer();
  try {
    const doc = await login(base);
    let r = await call(base, doc, '/api/db', { table: 'visit_documents', op: 'insert',
      values: { title: 'Протокол', doc_type: 'protocol', visit_id: 1, visit_service_id: 1, patient_id: 1 } });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error.code, 'refunded_line');
    r = await call(base, doc, '/api/rpc/visit_document_archive', { visit_service_id: 1, doc_type: 'protocol', title: 'Протокол', body: { complaints: 'Кашель' } });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.deepEqual([r.json.error.code, r.json.error.message], ['refunded_line', REFUNDED_SIGN_REFUSAL]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_documents WHERE visit_service_id = 1').get().n, 0);
    r = await call(base, doc, '/api/rpc/visit_document_archive', { visit_service_id: 2, doc_type: 'protocol', title: 'Протокол', body: { complaints: 'Кашель' } });
    assert.equal(r.status, 200, 'обычная строка — копия пишется. ' + JSON.stringify(r.json));
  } finally { server.close(); }
});
