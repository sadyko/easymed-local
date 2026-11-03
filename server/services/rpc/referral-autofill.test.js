// REPORTS_V2, ревью I3/I5 — visit_set_doctor_referrer ставил свой источник врача направившим
// ВИЗИТА по его рекомендации. REFERRAL_LINE_V1 · DOCTOR_REFERRAL_DESK_V1 (ревью полировки M1, N1):
// вызов снят — врач получает бонус только за услугу, которую направил (привязка к строке), а
// направившего всего визита выбирает стойка. Вызов зарегистрирован и ничего не пишет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { visitSetDoctorReferrer } from './referral-autofill.js';
import { getRpc } from './index.js';

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (1,'doc','x','doctor','Врачев В.В.',1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (5,'reg','x','registrar','Регистратура')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (1,'УЗИ',100000,0)").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Азизов А.')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (10,1,'2026-08-05T09:00:00Z')").run();   // приём врача
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (11,1,'2026-08-06T09:00:00Z')").run();   // визит по рекомендации
  // Всё, что прежде делало врача направившим визита: открытая рекомендация и строка её услуги,
  // которую стойка сама завела в визит после рекомендации.
  db.prepare("INSERT INTO recommended_services (id, patient_id, service_id, recommended_by, source_visit_id, status, created_at) VALUES (1,1,1,1,10,'pending','2026-08-05T09:30:00Z')").run();
  db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by, created_at) VALUES (11,1,1,100000,100000,'added',5,'2026-08-06T09:05:00Z')").run();
  return db;
}
const refOf = (db, id) => db.prepare('SELECT referral_source_id AS r FROM visits WHERE id = ?').get(id).r;

test('ревью полировки N1: вызов снят — зарегистрирован, ничего не пишет ни стойке, ни врачу, ни остальным', () => {
  const db = seed();
  const rpc = getRpc('visit_set_doctor_referrer');
  assert.equal(typeof rpc, 'function', 'вызов снят с регистрации — вкладка со старым окном визита получила бы отказ');
  const roles = [{ id: 5, role: 'registrar' }, { id: 6, role: 'admin' }, { id: 1, role: 'doctor', is_doctor: 1 },
    { id: 1, role: 'head_doctor' }, { id: 7, role: 'nurse' }, { id: 8, role: 'callcenter' }, { id: 2, role: 'lab' }];
  for (const who of roles) {
    for (const args of [{ visit_id: 11, doctor_id: 1, source_visit_id: 10 }, { visit_id: 11, recommendation_id: 1 }, {}]) {
      assert.deepEqual(rpc(db, args, who), { set: false, retired: true }, who.role + ' ' + JSON.stringify(args));
      assert.deepEqual(visitSetDoctorReferrer(db, args, who), { set: false, retired: true });
    }
  }
  assert.equal(refOf(db, 11), null, 'снятый вызов сделал врача направившим визита');
  assert.equal(db.prepare('SELECT status FROM recommended_services WHERE id = 1').get().status, 'pending', 'рекомендацию трогать нечем');
});

// REFERRAL_LINE_V1 (ревью полировки M1) — окно визита это правило больше НЕ зовёт: врач по своей
// рекомендации получает бонус только за её услугу (привязка ставит направившего строке), а не 10 %
// со всех строк визита.
test('добавление рекомендации в визит этого правила не зовёт; «Направить» из кабинета визит не трогает', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const vm = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'visit-modal.js'), 'utf8');
  const i = vm.indexOf('async function attachRecommendation(');
  const body = vm.slice(i, vm.indexOf('\nasync function ', i + 10));
  assert.match(body, /supabase\.rpc\('referral_recommendation_attach'/);
  assert.doesNotMatch(body, /rpc\(\s*'visit_set_doctor_referrer'/, 'окно визита делает рекомендовавшего направившим всего визита');
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'service-workspace.js'), 'utf8');
  const j = sw.indexOf('async function sendReferral(');
  const send = sw.slice(j, sw.indexOf('\nasync function ', j + 10));
  assert.doesNotMatch(send, /visit_set_doctor_referrer/, 'рекомендация помечает приём самого врача');
});
