// WAIT_REG_V1 (ревью M5) — «Ждут регистрации» В СЕТИ ЗДАНИЙ: пациента ждёт здание, куда он придёт.
//
// Межфилиальная запись (CROSS_BRANCH_CALENDAR_V1): здание B записывает пациента к врачу здания A —
// визит в B помечен cross_branch = 'A' и уезжает в A журналом; в A он лежит визитом соседа
// (sync_origin = 'B'), а здание приёма видно по приписке врача (она едет справочником). Прежде
// список брал только свои визиты: запись в чужое здание висела у автора, а у здания приёма её не было.
//
// Установка здесь — филиал B, получивший справочник главной клиники A настоящим приёмом
// (applyCatalogue(exportCatalogue(main))), как в calendar-cross-branch.test.js. Запись B → A —
// настоящим calendar_book; запись A → B приезжает визитом соседа (строки таблиц — как их кладёт
// приём журнала: sync_origin = буква автора, врач — местный по логину).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { calendarBook } from './calendar.js';
import { registrarWaiting } from './registrar-waiting.js';
import { registrarRegistered } from './registrar-desk.js';
import { ensureVisit } from './visits.js';
import { exportCatalogue, applyCatalogue } from '../branch-sync/catalogue.js';
import { becomeSecondary } from '../branch-sync/identity.js';

const registrar = { id: 1, role: 'registrar', extra_roles: [] };
const pad = (n) => String(n).padStart(2, '0');
const localDay = (off = 0) => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const at = (dayIso, hh, mm = 0) => { const [y, m, d] = dayIso.split('-').map(Number); return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString(); };
const TODAY = localDay(0);
const MINE = 'B';

function mainClinic() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("UPDATE branches SET name = 'Главный корпус' WHERE letter = 'A'").run();
  db.prepare('INSERT INTO branches (name, letter) VALUES (?, ?)').run('Второй корпус', MINE);
  const aId = db.prepare("SELECT id FROM branches WHERE letter = 'A'").get().id;
  const bId = db.prepare('SELECT id FROM branches WHERE letter = ?').get(MINE).id;
  db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor, working_hours, branch_id) VALUES ('doc','x','Петров П.П.','doctor',1,'',?)").run(bId);
  db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor, working_hours, branch_id) VALUES ('doc2','x','Каримов Р.','doctor',1,'',?)").run(aId);
  return db;
}

function branchB() {
  const db = openDb(':memory:');
  migrate(db);
  becomeSecondary(db, { letter: MINE, name: 'Второй корпус' });
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'reg','x','Регистратор','registrar',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (7,'doc','x','Петров П.П.','doctor',1,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (8,'doc2','x','Каримов Р.','doctor',1,'')").run();
  for (const [id, name] of [[3, 'Иванов Иван'], [4, 'Сидорова Мария'], [5, 'Каримова Нигора'], [6, 'Свой Олег']]) {
    db.prepare('INSERT INTO patients (id, full_name) VALUES (?, ?)').run(id, name);
  }
  db.prepare("INSERT INTO services (id, name, price, duration_minutes, code) VALUES (21,'Консультация',100000,30,'C-21')").run();
  const main = mainClinic();
  db.transaction(() => applyCatalogue(db, exportCatalogue(main)))();
  main.close();
  return db;
}

/** Визит соседа A, как его кладёт приём журнала: sync_origin = 'A', строка записи — тоже соседа. */
function foreignBooking(db, { uid, patient, doctor, hour }) {
  const vid = Number(db.prepare(`INSERT INTO visits (uid, sync_origin, patient_id, doctor_id, visit_date, duration_minutes, status, booked_at)
                                 VALUES (?, 'A', ?, ?, ?, 30, 'scheduled', ?)`).run(uid, patient, doctor, at(TODAY, hour), at(TODAY, 8)).lastInsertRowid);
  db.prepare(`INSERT INTO visit_services (uid, sync_origin, visit_id, service_id, quantity, unit_price, total, status)
              VALUES (?, 'A', ?, 21, 1, 100000, 100000, 'added')`).run(uid + '-l', vid);
  return vid;
}

test('WAIT_REG_V1 (ревью M5): запись в чужое здание — не у автора; запись соседа к нашему врачу — у нас; оформили своим визитом — ушла', async () => {
  const db = branchB();
  try {
    // B → A: настоящим calendar_book к врачу главного корпуса (cross_branch = 'A'), со строкой записи.
    const out = await calendarBook(db, { patient_id: 3, doctor_id: 8, service_id: 21, start: at(TODAY, 13), duration_minutes: 30 }, registrar,
      { publishImpl: async () => ({ ok: true }), dataDir: '/tmp/none' });
    assert.equal(out.visit.cross_branch, 'A', 'подготовка: запись не помечена зданием приёма');
    db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 21, 8, 1, 100000, 100000, 'added', 1)").run(out.visit.id);
    // Своя запись к своему врачу — как обычно.
    const own = await calendarBook(db, { patient_id: 6, doctor_id: 7, service_id: 21, start: at(TODAY, 11), duration_minutes: 30 }, registrar,
      { publishImpl: async () => ({ ok: true }), dataDir: '/tmp/none' });
    db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 21, 7, 1, 100000, 100000, 'added', 1)").run(own.visit.id);
    // A → B: запись соседа к НАШЕМУ врачу (7) и запись соседа к его собственному врачу (8).
    const theirs = foreignBooking(db, { uid: 'uid-a-for-b', patient: 4, doctor: 7, hour: 15 });
    foreignBooking(db, { uid: 'uid-a-for-a', patient: 5, doctor: 8, hour: 16 });

    const data = registrarWaiting(db, {}, registrar);
    const ids = data.rows.map((r) => r.patient_id).sort();
    assert.deepEqual(ids, [4, 6], 'здание приёма: ' + JSON.stringify(data.rows.map((r) => [r.patient_id, r.patient_name])));
    const r4 = data.rows.find((r) => r.patient_id === 4);
    assert.equal(r4.visit_id, theirs);
    assert.equal(r4.time, '15:00');
    assert.deepEqual(r4.services, ['Консультация']);
    assert.deepEqual(r4.lines.map((l) => [l.kind, l.foreign, l.service_id, l.doctor_id]), [['booked', true, 21, 7]],
      'строка соседа не помечена (или без врача визита) — окно визита не узнает, что её надо набрать');
    assert.deepEqual(r4.doctors, ['Петров П.П.']);
    assert.equal(registrarWaiting(db, { count_only: true }, registrar).count, 2);

    // Стойка B оформила пациента своим визитом дня (счёт по визиту соседа не выставить) — запись соседа ушла.
    const ev = await ensureVisit(db, { patient_id: 4, date: new Date().toISOString(), visit_type: 'outpatient', desk: true }, registrar);
    assert.notEqual(ev.visit.id, theirs, 'стойка взяла визит соседа');
    registrarRegistered(db, { visit_id: ev.visit.id }, registrar);
    assert.deepEqual(registrarWaiting(db, {}, registrar).rows.map((r) => r.patient_id), [6]);
  } finally { db.close(); }
});

test('WAIT_REG_V1 (ревью M5): одна установка без сети — свои записи, как прежде', async () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (1,'reg','x','Регистратор','registrar',0)").run();
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (7,'doc','x','Петров','doctor',1)").run();
    db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
    db.prepare("INSERT INTO services (id, name, price, duration_minutes) VALUES (21,'Консультация',100000,30)").run();
    const v = Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by, booked_at) VALUES (3, 7, ?, 'scheduled', 1, ?)").run(at(TODAY, 12), at(TODAY, 8)).lastInsertRowid);
    db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 21, 7, 1, 100000, 100000, 'added', 1)").run(v);
    assert.deepEqual(registrarWaiting(db, {}, registrar).rows.map((r) => r.patient_id), [3]);
  } finally { db.close(); }
});
