// INPATIENT_BONUS_V1 (мигр. 155) — госпитализация запоминает, КТО НАПРАВИЛ.
//
// По умолчанию — источник последнего визита пациента (отменённые и «не
// пришёл» не в счёт), у последнего визита источника нет или визитов нет —
// источник из карточки пациента. Заявка регистратуры (admission_order_create)
// и заявка врача из кабинета (request_admission) пишут одно и то же; окно
// заявки спрашивает значение по умолчанию (admission_referral_default) и
// может его сменить или снять.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, requestAdmission, admissionReferralDefault, defaultAdmissionReferralSource } from './inpatient.js';

const registrar = { id: 2, role: 'registrar' };
const doctor = { id: 4, role: 'doctor' };
const cashier = { id: 5, role: 'cashier' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  for (const [id, username, role] of [[2, 'reg1', 'registrar'], [4, 'doc1', 'doctor'], [5, 'cash1', 'cashier']]) {
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)').run(id, username, 'x', role);
  }
  const src = (name) => db.prepare('INSERT INTO referral_sources (name) VALUES (?)').run(name).lastInsertRowid;
  const card = src('Карточка');
  const visitOld = src('Старый визит');
  const visitNew = src('Последний визит');
  const other = src('Другой');
  const p = db.prepare("INSERT INTO patients (full_name, referral_source_id) VALUES ('Иванов Иван', ?)").run(card).lastInsertRowid;
  const v = db.prepare('INSERT INTO visits (patient_id, visit_date, status, referral_source_id) VALUES (?,?,?,?)');
  return { db, p, card, visitOld, visitNew, other, v };
}
const adm = (db, id) => db.prepare('SELECT referral_source_id FROM admissions WHERE id = ?').get(id).referral_source_id;

test('по умолчанию — источник последнего визита; отменённый визит не в счёт', () => {
  const { db, p, visitOld, visitNew, v } = seed();
  v.run(p, '2026-08-01T09:00:00Z', 'arrived', visitOld);
  v.run(p, '2026-08-05T09:00:00Z', 'arrived', visitNew);
  v.run(p, '2026-08-09T09:00:00Z', 'cancelled', visitOld);
  assert.equal(defaultAdmissionReferralSource(db, p), visitNew);
  const { admission } = admissionOrderCreate(db, { patient_id: p }, registrar);
  assert.equal(admission.referral_source_id, visitNew);
});

test('у последнего визита источника нет — источник из карточки; визитов нет — тоже карточка', () => {
  const { db, p, card, visitOld, v } = seed();
  assert.equal(defaultAdmissionReferralSource(db, p), card, 'без визитов — карточка');
  v.run(p, '2026-08-01T09:00:00Z', 'arrived', visitOld);
  v.run(p, '2026-08-05T09:00:00Z', 'arrived', null);
  assert.equal(defaultAdmissionReferralSource(db, p), card);
  const { admission } = requestAdmission(db, { patient_id: p }, doctor);
  assert.equal(adm(db, admission.id), card, 'заявка врача из кабинета тоже запоминает направившего');
});

test('в заявке направившего меняют или снимают; чужой номер — отказ', () => {
  const { db, p, other } = seed();
  const a = admissionOrderCreate(db, { patient_id: p, referral_source_id: other }, registrar).admission;
  assert.equal(a.referral_source_id, other);
  db.prepare("UPDATE admissions SET status = 'cancelled' WHERE id = ?").run(a.id);
  const b = admissionOrderCreate(db, { patient_id: p, referral_source_id: null }, registrar).admission;
  assert.equal(b.referral_source_id, null, 'снятый направивший подставился обратно');
  db.prepare("UPDATE admissions SET status = 'cancelled' WHERE id = ?").run(b.id);
  assert.throws(() => admissionOrderCreate(db, { patient_id: p, referral_source_id: 99999 }, registrar), /Источник направления не найден/);
  assert.throws(() => admissionOrderCreate(db, { patient_id: p, referral_source_id: 'x' }, registrar), /referral_source_id/);
});

test('admission_referral_default: окно заявки получает источник с именем; ворота — как у заявки', () => {
  const { db, p, visitNew, v } = seed();
  v.run(p, '2026-08-05T09:00:00Z', 'arrived', visitNew);
  const r = admissionReferralDefault(db, { patient_id: p }, registrar);
  assert.equal(r.referral_source_id, visitNew);
  assert.equal(r.name, 'Последний визит');
  assert.ok(r.code, 'номер источника присваивает триггер');
  assert.throws(() => admissionReferralDefault(db, { patient_id: p }, cashier), /недоступно вашей роли/);
  assert.throws(() => admissionReferralDefault(db, { patient_id: 0 }, registrar), /patient_id/);
  // Удалили источник — госпитализация остаётся без направившего (ON DELETE SET NULL).
  const { admission } = admissionOrderCreate(db, { patient_id: p }, registrar);
  db.prepare('UPDATE visits SET referral_source_id = NULL').run();
  db.prepare('DELETE FROM referral_sources WHERE id = ?').run(visitNew);
  assert.equal(adm(db, admission.id), null);
});
