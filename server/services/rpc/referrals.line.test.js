// REFERRAL_LINE_V1 — экран «Реферирование» считает направления и по строкам визита:
// «Внутренние врачи» — рекомендации + строки с источником врача (строка, которой закрыта
// рекомендация, — та же рекомендация); внешние — визит «по источнику», если источник у
// визита/пациента ИЛИ у живой строки визита (тогда суммы сходятся со строками «Рефералов»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { referralsInternal, referralsDoctorDetail, referralsRepresentatives, referralsSourceDetail, referralsActivity } from './referrals.js';

const ymd = (daysAgo) => {
  const d = new Date(); d.setDate(d.getDate() - daysAgo);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const atNoon = (daysAgo) => new Date(ymd(daysAgo) + 'T12:00:00').toISOString();
const admin = { id: 1, role: 'admin' };
const period = { from: ymd(30), to: ymd(0) };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, specialty) VALUES (?,?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'admin', 'Администратор', '');
  u.run(3, 'doc', 'x', 'doctor', 'Врач Внутренний', 'Невролог');
  u.run(4, 'uzi', 'x', 'doctor', 'Исполнитель', 'УЗИ');
  const internal = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 3').get().id;
  const B = Number(db.prepare("INSERT INTO referral_sources (name, first_name) VALUES ('Набиев Ойбек', 'Ойбек')").run().lastInsertRowid);
  db.prepare("INSERT INTO services (id, name, price) VALUES (50, 'УЗИ', 80000), (51, 'ЭКГ', 50000)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (10, 'Пациент Первый'), (11, 'Пациент Второй')").run();
  const vis = db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (?, 4, ?, 'arrived')");
  const v1 = Number(vis.run(10, atNoon(1)).lastInsertRowid);
  const v2 = Number(vis.run(10, atNoon(2)).lastInsertRowid);
  const v3 = Number(vis.run(11, atNoon(3)).lastInsertRowid);
  const line = db.prepare('INSERT INTO visit_services (visit_id, service_id, doctor_id, status, referred_by_source_id, created_at) VALUES (?, ?, 4, ?, ?, ?)');
  line.run(v1, 50, 'added', internal, atNoon(1));                                  // ждёт
  line.run(v2, 50, 'completed', internal, atNoon(2));                              // выполнено
  const fromRec = Number(line.run(v2, 51, 'added', internal, atNoon(2)).lastInsertRowid);   // этой строкой закрыта рекомендация
  db.prepare("INSERT INTO recommended_services (patient_id, service_id, service_name, recommended_by, status, created_at, visit_service_id) VALUES (10, 51, 'ЭКГ', 3, 'done', ?, ?)")
    .run(atNoon(2), fromRec);
  line.run(v3, 50, 'added', B, atNoon(3));                                         // внешний врач — только строкой
  return { db, B, v3, internal, line, vis };
}

test('«Внутренние врачи»: рекомендации + строки с его источником; строка рекомендации — один раз', () => {
  const { db } = fresh();
  const out = referralsInternal(db, period, admin);
  const d = out.doctors.find((r) => r.id === 3);
  assert.deepEqual([d.referrals, d.done, d.waiting, d.cancelled, d.patients], [3, 2, 1, 0, 1]);
  assert.equal(out.totals.doctors_referring, 1);
  const other = out.doctors.find((r) => r.id === 4);
  assert.deepEqual([other.referrals, other.done, other.waiting], [0, 0, 0]);
});

test('подробности врача: строки направлений рядом с рекомендациями, новые сначала', () => {
  const { db } = fresh();
  const det = referralsDoctorDetail(db, { doctor_id: 3, ...period }, admin);
  assert.deepEqual(det.referrals.map((r) => [r.service, r.status]), [['УЗИ', 'pending'], ['ЭКГ', 'done'], ['УЗИ', 'done']]);
});

test('внешний врач, направивший только строкой: визит в «Представителях», «Подробнее» и активности', () => {
  const { db, B, v3 } = fresh();
  const rep = referralsRepresentatives(db, period, admin);
  const row = rep.sources.find((s) => s.id === B);
  assert.deepEqual([row.visits, row.patients], [1, 1]);
  assert.equal(rep.totals.patients, 1);
  assert.deepEqual(referralsSourceDetail(db, { source_id: B, ...period }, admin).visits.map((v) => v.visit_id), [v3]);
  const act = referralsActivity(db, {}, admin).sources.find((s) => s.id === B);
  assert.equal(act.last_visit, ymd(3));
});

// К3 · К5 — «Вернуть эту услугу и выставить новую» оставляет в визите прежнюю строку (отпущена
// со счёта с возвратом) и заводит новую с тем же направившим: направление одно, а не два.
// Возвращённая строка («Вернуть услугу») направлением врача больше не считается — как у
// журнала услуг и выплаты врачу (pay_refund_releases на невыставленной строке).
test('К3/К5: возвращённая строка не считается направлением — «вернуть и выставить новую» даёт одно направление', () => {
  const { db, internal, line, vis } = fresh();
  const v4 = Number(vis.run(11, atNoon(4)).lastInsertRowid);
  const old = Number(line.run(v4, 50, 'completed', internal, atNoon(4)).lastInsertRowid);
  const inv = Number(db.prepare("INSERT INTO invoices (invoice_number, visit_id, patient_id, total_amount, paid_amount, status) VALUES ('R-1', ?, 11, 80000, 80000, 'paid')").run(v4).lastInsertRowid);
  db.prepare("INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out', ?, ?)").run(old, inv);
  line.run(v4, 51, 'added', internal, atNoon(4));                                  // новая строка позиции счёта
  const d = referralsInternal(db, period, admin).doctors.find((r) => r.id === 3);
  assert.deepEqual([d.referrals, d.done, d.waiting, d.patients], [4, 2, 2, 2], 'возвращённая строка посчитана вторым направлением');
  const det = referralsDoctorDetail(db, { doctor_id: 3, ...period }, admin);
  assert.equal(det.referrals.length, 4);
});
