// ADMISSION_DATE_EDIT_V1 — дату поступления можно исправить.
//
// Дата поступления — не справочное поле: из неё считаются койко-дни, а значит и
// счёт за проживание. Поэтому правка идёт через RPC (в реестре у admissions
// запись запрещена вовсе — «money is server-computed»), жёстко проверяется и
// попадает в журнал движения: кто, когда и с какой на какую.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admitPatient, dischargePatient } from './inpatient.js';
import { setAdmissionDate } from './admission-date.js';
import { billAccommodation, accommodationState } from './accommodation.js';

const NURSE = { id: 2, role: 'nurse', full_name: 'Медсестра' };
const LAB   = { id: 5, role: 'lab', full_name: 'Лаборант' };
const DOC_ID = 3;

// СТАРЫЙ ПУТЬ ПОСТУПЛЕНИЯ ТЕПЕРЬ ТОЛЬКО ДЛЯ ДООБНОВЛЕНЧЕСКИХ ЗАЯВОК.
// `admit_patient` больше не заводит новую госпитализацию и требует лечащего
// врача (isLegacyAdmission, rpc/inpatient.js): одно нажатие открывало лечение
// без осмотра и без врача. Этой фикстуре нужен просто пациент в койке, поэтому
// она заводит заявку с датой ДО обновления — ровно то, что видит клиника в день
// установки.
function legacyAdmit(db, args, user) {
    db.prepare("INSERT INTO admissions (patient_id, doctor_id, status, created_at)"
             + " VALUES (?,?,'ordered','2000-01-01T00:00:00Z')").run(args.patient_id, args.doctor_id ?? null);
    return admitPatient(db, args, user);
}

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (2,'n','x','nurse','Медсестра')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (3,'d','x','doctor','Др. Азиза')").run();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const wid = db.prepare("INSERT INTO wards (name, billing_mode, price_per_day) VALUES ('201','daily',250000)").run().lastInsertRowid;
  const bid = db.prepare("INSERT INTO beds (ward_id, code, status) VALUES (?,'1','free')").run(wid).lastInsertRowid;
  const adm = legacyAdmit(db, { patient_id: pid, bed_id: bid, doctor_id: DOC_ID }, NURSE).admission;
  return { db, adm };
}
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 19) + 'Z';

test('дата поступления меняется', () => {
  const { db, adm } = seed();
  const when = iso(3);
  const out = setAdmissionDate(db, { admission_id: adm.id, admitted_at: when }, NURSE);
  assert.equal(out.admission.admitted_at, when);
  assert.equal(db.prepare('SELECT admitted_at FROM admissions WHERE id=?').get(adm.id).admitted_at, when);
  db.close();
});

// Изменение даты — это изменение суммы. Кто и с какой на какую, должно
// остаться в журнале движения, иначе счёт вырос, а объяснить некому.
test('правка попадает в журнал движения', () => {
  const { db, adm } = seed();
  const before = db.prepare('SELECT admitted_at FROM admissions WHERE id=?').get(adm.id).admitted_at;
  setAdmissionDate(db, { admission_id: adm.id, admitted_at: iso(2) }, NURSE);

  const rec = db.prepare("SELECT * FROM admission_transfers WHERE admission_id=? AND kind='admitted_at' ORDER BY id DESC LIMIT 1").get(adm.id);
  assert.ok(rec, 'запись в журнале обязана быть');
  assert.equal(rec.transferred_by, NURSE.id);
  assert.match(rec.reason, new RegExp(before.slice(0, 10)), 'в записи видна прежняя дата');
  db.close();
});

// Будущее нельзя: пациент не может поступить завтра, а койко-дни ушли бы в минус.
test('дата из будущего отклоняется', () => {
  const { db, adm } = seed();
  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  assert.throws(() => setAdmissionDate(db, { admission_id: adm.id, admitted_at: tomorrow }, NURSE), /будущ|future/i);
  db.close();
});

test('мусор вместо даты отклоняется', () => {
  const { db, adm } = seed();
  for (const bad of ['вчера', '', null, undefined, 42, '2026-13-45']) {
    assert.throws(() => setAdmissionDate(db, { admission_id: adm.id, admitted_at: bad }, NURSE), /дат|date/i, JSON.stringify(bad));
  }
  db.close();
});

// Поступление позже выписки — отрицательный срок и отрицательный счёт.
test('нельзя поставить дату позже выписки', () => {
  const { db, adm } = seed();
  dischargePatient(db, { admission_id: adm.id }, NURSE);
  // Выписку отодвигаем в прошлое, иначе «позже выписки» окажется ещё и в
  // будущем, и сработает другая проверка — тест перестал бы проверять эту.
  db.prepare("UPDATE admissions SET discharged_at = datetime('now','-2 days') WHERE id=?").run(adm.id);
  assert.throws(() => setAdmissionDate(db, { admission_id: adm.id, admitted_at: iso(1) }, NURSE), /выписк|discharge/i);
  db.close();
});

test('роли: лаборант дату не правит', () => {
  const { db, adm } = seed();
  assert.throws(() => setAdmissionDate(db, { admission_id: adm.id, admitted_at: iso(1) }, LAB), /not allowed/);
  db.close();
});

// Внесённое проживание считалось от СТАРОЙ даты. После правки карточка обязана
// показать, что снимок устарел, — иначе клиника молча недосчитается денег.
test('после правки внесённое проживание помечается устаревшим', () => {
  const { db, adm } = seed();
  db.prepare("UPDATE admissions SET admitted_at = datetime('now','-1 days') WHERE id=?").run(adm.id);
  billAccommodation(db, { admission_id: adm.id }, NURSE);
  assert.equal(accommodationState(db, { admission_id: adm.id }, NURSE).stale, false);

  setAdmissionDate(db, { admission_id: adm.id, admitted_at: iso(5) }, NURSE);

  const st = accommodationState(db, { admission_id: adm.id }, NURSE);
  assert.equal(st.stale, true, 'срок вырос — снимок устарел');
  assert.ok(st.current.net > st.billed.total);
  db.close();
});
