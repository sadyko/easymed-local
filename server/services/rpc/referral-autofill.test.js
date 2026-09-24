// REPORTS_V2, ревью I3/I5 — свой источник врача на визите по его рекомендации,
// только когда направившего нет ни у визита, ни у пациента.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { visitSetDoctorReferrer } from './referral-autofill.js';
import { getRpc } from './index.js';
import { runReport } from './reports.js';

const reg = { id: 5, role: 'registrar' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (1,'doc','x','doctor','Врачев В.В.',1)").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Азизов А.')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (10,1,'2026-08-05T09:00:00Z')").run();   // приём врача
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (11,1,'2026-08-06T09:00:00Z')").run();   // визит по рекомендации
  const own = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 1').get().id;
  const partner = db.prepare("INSERT INTO referral_sources (name) VALUES ('Клиника Х')").run().lastInsertRowid;
  return { db, own, partner };
}
const refOf = (db, id) => db.prepare('SELECT referral_source_id AS r FROM visits WHERE id = ?').get(id).r;

test('пациент без направившего: рекомендация врача засчитывается врачу', () => {
  const { db, own } = seed();
  const r = visitSetDoctorReferrer(db, { visit_id: 11, doctor_id: 1, source_visit_id: 10 }, reg);
  assert.deepEqual(r, { set: true, reason: 'set', referral_source_id: own });
  assert.equal(refOf(db, 11), own);
});

test('пациент партнёра остаётся пациентом партнёра', () => {
  const { db, partner } = seed();
  db.prepare('UPDATE patients SET referral_source_id = ? WHERE id = 1').run(partner);
  const r = visitSetDoctorReferrer(db, { visit_id: 11, doctor_id: 1 }, reg);
  assert.equal(r.reason, 'patient_has');
  assert.equal(refOf(db, 11), null);
});

test('у визита уже есть направивший — не трогается', () => {
  const { db, partner } = seed();
  db.prepare('UPDATE visits SET referral_source_id = ? WHERE id = 11').run(partner);
  assert.equal(visitSetDoctorReferrer(db, { visit_id: 11, doctor_id: 1 }, reg).reason, 'visit_has');
  assert.equal(refOf(db, 11), partner);
});

test('визит, на котором врач сам рекомендовал, не помечается (иначе его приём стал бы «направлением»)', () => {
  const { db } = seed();
  assert.equal(visitSetDoctorReferrer(db, { visit_id: 10, doctor_id: 1, source_visit_id: 10 }, reg).reason, 'own_visit');
  assert.equal(refOf(db, 10), null);
});

test('без своего источника — ничего; чужая роль — 403; зарегистрирован как RPC', () => {
  const { db } = seed();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (2,'lab','x','lab','Лаборант')").run();
  assert.equal(visitSetDoctorReferrer(db, { visit_id: 11, doctor_id: 2 }, reg).reason, 'no_source');
  assert.throws(() => visitSetDoctorReferrer(db, { visit_id: 11, doctor_id: 1 }, { id: 2, role: 'lab' }), (e) => e.status === 403);
  assert.equal(typeof getRpc('visit_set_doctor_referrer'), 'function');
});

test('после пометки «Рефералы» засчитывают строку визита врачу', () => {
  const { db } = seed();
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (1,'УЗИ',100000,0)").run();
  db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
              VALUES (1,'INV-1',11,1,100000,0,100000,100000,'paid','2026-08-06T10:00:00Z')`).run();
  db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (1,1,'УЗИ',1,100000,100000)").run();
  visitSetDoctorReferrer(db, { visit_id: 11, doctor_id: 1 }, reg);
  const r = runReport(db, { kind: 'referrals', from: '2026-08-01', to: '2026-08-31', referrer: 'internal' }, { id: 9, role: 'admin' });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0][r.columns.indexOf('Источник')], 'Врачев В.В.');
});

test('добавление рекомендации в визит зовёт это правило; «Направить» из кабинета визит не трогает', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const vm = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'visit-modal.js'), 'utf8');
  const i = vm.indexOf('async function attachRecommendation(');
  const body = vm.slice(i, vm.indexOf('\nasync function ', i + 10));
  assert.match(body, /supabase\.rpc\('visit_set_doctor_referrer', \{\s*visit_id: state\.visit\.id, doctor_id: rec\.recommended_by, source_visit_id: rec\.source_visit_id \?\? null \}\)/);
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'service-workspace.js'), 'utf8');
  const j = sw.indexOf('async function sendReferral(');
  const send = sw.slice(j, sw.indexOf('\nasync function ', j + 10));
  assert.doesNotMatch(send, /visit_set_doctor_referrer/, 'рекомендация помечает приём самого врача');
});
