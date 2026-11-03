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
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (5,'reg','x','registrar','Регистратура')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (1,'УЗИ',100000,0)").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Азизов А.')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (10,1,'2026-08-05T09:00:00Z')").run();   // приём врача
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (11,1,'2026-08-06T09:00:00Z')").run();   // визит по рекомендации
  const own = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 1').get().id;
  const partner = db.prepare("INSERT INTO referral_sources (name) VALUES ('Клиника Х')").run().lastInsertRowid;
  // V3120_FIX (M3) — направившего ставит только ОТКРЫТАЯ рекомендация врача
  // этому пациенту (окно визита зовёт обработчик до того, как закроет её).
  db.prepare("INSERT INTO recommended_services (patient_id, service_id, recommended_by, source_visit_id, status, created_at) VALUES (1,1,1,10,'pending','2026-08-05T09:30:00Z')").run();
  // REFERRAL_LINE_V1 (полировка, п. 7) — и строка услуги рекомендации, которую стойка сама
  // завела в визит после рекомендации (окно визита вставляет её прямо перед вызовом).
  const line = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by, created_at) VALUES (?,1,1,100000,100000,'added',5,?)");
  line.run(10, '2026-08-05T10:00:00Z');
  line.run(11, '2026-08-06T09:05:00Z');
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
  db.prepare("INSERT INTO recommended_services (patient_id, service_id, recommended_by, status, created_at) VALUES (1,1,2,'pending','2026-08-05T09:40:00Z')").run();
  assert.equal(visitSetDoctorReferrer(db, { visit_id: 11, doctor_id: 2 }, reg).reason, 'no_source');
  assert.throws(() => visitSetDoctorReferrer(db, { visit_id: 11, doctor_id: 1 }, { id: 2, role: 'lab' }), (e) => e.status === 403);
  assert.equal(typeof getRpc('visit_set_doctor_referrer'), 'function');
});

test('после пометки «Рефералы» засчитывают строку визита врачу', () => {
  const { db } = seed();   // услуга «УЗИ» (1) — в seed (полировка, п. 7)
  visitSetDoctorReferrer(db, { visit_id: 11, doctor_id: 1 }, reg);   // V3120_FIX (M3) — до оплаты: оплаченный визит не трогается
  db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
              VALUES (1,'INV-1',11,1,100000,0,100000,100000,'paid','2026-08-06T10:00:00Z')`).run();
  db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (1,1,'УЗИ',1,100000,100000)").run();
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

// REFERRAL_LINE_V1 (полировка 3.21.0, п. 7; ревью U10 — MEDIUM) — источник визита платит за КАЖДУЮ
// строку визита: ставит его только стойка и только по строке услуги рекомендации в этом визите,
// которую она сама завела не раньше рекомендации. Проба R1e: врач писал рекомендацию задним
// числом и называл себя направившим всего визита стойки.
test('полировка п. 7: врач, главврач, медсестра — 403; стойка — только по своей живой строке услуги рекомендации, не старше рекомендации', () => {
  const { db, own } = seed();
  for (const who of [{ id: 1, role: 'doctor', is_doctor: 1 }, { id: 1, role: 'head_doctor' }, { id: 7, role: 'nurse' }, { id: 7, role: 'senior_nurse' }]) {
    assert.throws(() => visitSetDoctorReferrer(db, { visit_id: 11, doctor_id: 1 }, who), (e) => e.status === 403, who.role);
  }
  assert.equal(refOf(db, 11), null);
  // строка другого сотрудника, другой услуги, отменённая, старше рекомендации — не доказательство
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (6,'reg2','x','registrar','Регистратура 2')").run();
  const reg2 = { id: 6, role: 'registrar' };
  const no = (u) => assert.throws(() => visitSetDoctorReferrer(db, { visit_id: 11, doctor_id: 1 }, u), (e) => e.status === 409 && /такой строки нет/.test(e.message));
  no(reg2);
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (2,'ЭКГ',50000,0)").run();
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by, created_at) VALUES (11,?,1,1,1,?,6,?)");
  vs.run(2, 'added', '2026-08-06T09:10:00Z'); no(reg2);
  vs.run(1, 'cancelled', '2026-08-06T09:10:00Z'); no(reg2);
  vs.run(1, 'added', '2026-08-05T09:00:00Z'); no(reg2);   // строка раньше рекомендации (09:30)
  const refunded = Number(vs.run(1, 'added', '2026-08-06T09:20:00Z').lastInsertRowid);
  db.prepare("INSERT INTO invoices (id, patient_id, visit_id, status) VALUES (90,1,11,'refunded')").run();
  db.prepare("INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out',?,90)").run(refunded);
  no(reg2);
  assert.equal(refOf(db, 11), null);
  // своя живая строка — ставится (администратор — тоже стойка); по номеру рекомендации — тоже
  vs.run(1, 'added', '2026-08-06T09:30:00Z');
  assert.deepEqual(visitSetDoctorReferrer(db, { visit_id: 11, recommendation_id: 1 }, { id: 6, role: 'admin' }), { set: true, reason: 'set', referral_source_id: own });
});

test('полировка п. 7: по doctor_id берётся рекомендация врача, у которой есть своя строка; без такой — 409', () => {
  const { db, own } = seed();
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (3,'Анализ крови',40000,0)").run();
  // свежая рекомендация того же врача на другую услугу — строки по ней нет
  db.prepare("INSERT INTO recommended_services (patient_id, service_id, recommended_by, status, created_at) VALUES (1,3,1,'pending','2026-08-06T09:50:00Z')").run();
  assert.deepEqual(visitSetDoctorReferrer(db, { visit_id: 11, doctor_id: 1 }, reg), { set: true, reason: 'set', referral_source_id: own });
  const fresh = seed();
  fresh.db.prepare('UPDATE visit_services SET created_by = NULL').run();
  assert.throws(() => visitSetDoctorReferrer(fresh.db, { visit_id: 11, doctor_id: 1 }, reg), (e) => e.status === 409);
  assert.equal(refOf(fresh.db, 11), null);
});
