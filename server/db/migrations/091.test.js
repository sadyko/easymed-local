// 091.test.js — INPATIENT_FLOW_V1: маршрут госпитализации, и главное —
// РАБОТАЮЩАЯ КЛИНИКА ЭТОГО НЕ ЗАМЕЧАЕТ.
//
// Проверяется обещание из шапки миграции. Обычный fresh()-тест его проверить не
// может: migrate() применяет ВСЕ файлы разом, и старой таблицы в такой базе
// никогда не существует. Поэтому здесь база собирается ДО 091, в неё кладутся
// строки старой формы (во всех четырёх старых статусах, включая 'requested',
// который живёт в живых базах с миграции 032) — и только потом применяется 091.
// Иначе «данные переживают пересборку» осталось бы утверждением, а не фактом.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const M091 = '091_inpatient_workflow.sql';

const NEW_STATUSES = ['ordered', 'admitted', 'examined', 'active', 'discharging', 'discharged', 'cancelled'];

/** База ровно в том виде, в каком её застаёт 091 на работающей клинике. */
function dbBefore091() {
  const db = openDb(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= M091) break;
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    })();
  }
  return db;
}

function apply091(db) {
  const sql = fs.readFileSync(path.join(DIR, M091), 'utf8');
  db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(M091);
  })();
}

/** Клиника накануне обновления: люди, палата, койки, четыре госпитализации. */
function clinicBefore() {
  const db = dbBefore091();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'reg','x','Регистратор','registrar')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'doc','x','Др. Азиза','doctor')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (2,'Петров Пётр')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Сидоров Сидор')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (4,'Каримов Карим')").run();
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1,'Терапия','daily',150000)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'K-1',1,'occupied')").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (2,'K-2',1,'free')").run();

  const ins = db.prepare(`INSERT INTO admissions
      (id, admission_no, patient_id, bed_id, ward_id, doctor_id, pathway, chief_complaint,
       admission_diagnosis, admitted_at, discharged_at, status,
       accommodation_discount_percent, charge_amount, invoice_id, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  // Лежит прямо сейчас — та самая строка, которую нельзя потерять.
  ins.run(10, 'ADM-00010', 1, 1, 1, 2, 'therapy', 'боль в животе', 'K35',
    '2026-09-01T08:00:00Z', null, 'active', 15, null, null, 1, '2026-09-01T08:00:00Z');
  // Уже выписан и посчитан.
  ins.run(11, 'ADM-00011', 2, null, 1, 2, 'surgical', 'плановая операция', 'K80',
    '2026-08-20T09:00:00Z', '2026-08-25T11:00:00Z', 'discharged', 0, 750000, null, 1, '2026-08-20T09:00:00Z');
  // Отменённая заявка.
  ins.run(12, 'ADM-00012', 3, null, null, 2, 'therapy', '', '',
    '2026-08-28T10:00:00Z', '2026-08-28T12:00:00Z', 'cancelled', 0, null, null, 1, '2026-08-28T10:00:00Z');
  // ЧЕТВЁРТЫЙ статус, которого не было в задании и который есть в живой базе:
  // заявка врача из кабинета (миграция 032, request_admission).
  ins.run(13, 'ADM-00013', 4, null, null, 2, 'therapy', 'одышка', '',
    '2026-09-03T14:00:00Z', null, 'requested', 0, null, null, 1, '2026-09-03T14:00:00Z');

  // Дочерние строки: пересборка обязана оставить их привязанными.
  db.prepare(`INSERT INTO admission_services (id, admission_id, ward_id, bed_id, quantity, unit_price, total, status, notes)
              VALUES (1, 10, 1, 1, 2, 150000, 255000, 'added', 'ПРОЖИВАНИЕ · Терапия')`).run();
  db.prepare(`INSERT INTO admission_transfers (id, admission_id, to_bed_id, to_ward_id, kind, transferred_by)
              VALUES (1, 10, 1, 1, 'admit', 1)`).run();
  db.prepare(`INSERT INTO admission_prescriptions (id, admission_id, patient_id, name, prescribed_by)
              VALUES (1, 10, 1, 'Цефтриаксон', 2)`).run();
  db.prepare(`INSERT INTO med_administrations (id, admission_id, patient_id, med_name, administered_by)
              VALUES (1, 10, 1, 'Цефтриаксон', 1)`).run();
  db.prepare(`INSERT INTO invoices (id, invoice_number, patient_id, admission_id, subtotal, total_amount, status)
              VALUES (1, 'INV-A-26-00001', 2, 11, 750000, 750000, 'paid')`).run();

  // Счётчик AUTOINCREMENT ушёл выше MAX(id): госпитализацию №14 завели и
  // удалили. Её id не должен достаться следующей новой.
  db.prepare("UPDATE sqlite_sequence SET seq = 14 WHERE name = 'admissions'").run();
  return db;
}

const admissionsRows = (db) => db.prepare('SELECT * FROM admissions ORDER BY id').all();

test('091: каждая старая строка переживает пересборку без единого изменения', () => {
  const db = clinicBefore();
  const before = admissionsRows(db);
  apply091(db);
  const after = admissionsRows(db);

  assert.equal(after.length, 4, 'ни одна госпитализация не потеряна');
  for (let i = 0; i < before.length; i++) {
    const b = before[i], a = after[i];
    // Всё, кроме статуса (он мог быть переименован), обязано совпасть дословно.
    for (const col of ['id', 'admission_no', 'patient_id', 'bed_id', 'ward_id', 'doctor_id',
      'pathway', 'chief_complaint', 'admission_diagnosis', 'admitted_at', 'discharged_at',
      'accommodation_discount_percent', 'charge_amount', 'invoice_id', 'created_by', 'created_at']) {
      assert.deepEqual(a[col], b[col], `строка ${b.id}: колонка ${col} изменилась`);
    }
  }
  db.close();
});

test('091: статусы отображаются как обещано — три тождественно, requested → ordered', () => {
  const db = clinicBefore();
  apply091(db);
  const byId = new Map(admissionsRows(db).map((r) => [r.id, r]));
  assert.equal(byId.get(10).status, 'active',     'лежащий пациент продолжает лежать');
  assert.equal(byId.get(11).status, 'discharged', 'выписанный остаётся выписанным');
  assert.equal(byId.get(12).status, 'cancelled',  'отменённая остаётся отменённой');
  assert.equal(byId.get(13).status, 'ordered',    'заявка врача — это и есть «заявка оформлена»');
  db.close();
});

test('091: новые колонки заполнены ровно так, как обещает шапка', () => {
  const db = clinicBefore();
  apply091(db);
  const byId = new Map(admissionsRows(db).map((r) => [r.id, r]));

  const live = byId.get(10);
  assert.equal(live.attending_doctor_id, 2, 'лечащий врач := прежний doctor_id');
  assert.equal(live.ordered_at, '2026-09-01T08:00:00Z', 'ordered_at := admitted_at');
  assert.equal(live.ordered_by, 1, 'ordered_by := created_by');
  assert.equal(live.admitted_by, 1, 'пациент действительно поступал — есть кем подписать');
  assert.equal(live.examined_at, null, 'осмотра как этапа до сих пор не существовало');
  assert.equal(live.examined_by, null);
  assert.equal(live.admission_type, 'planned');
  assert.equal(live.stay_mode, 'round');
  assert.equal(live.planned_discharge_at, null);
  assert.equal(live.cancel_reason, '');

  // У оставшейся заявкой строки поступления НЕ БЫЛО: подписывать его некем.
  assert.equal(byId.get(13).admitted_by, null, 'события, которого не было, в базе быть не должно');
  assert.equal(byId.get(13).ordered_by, 1);
  db.close();
});

test('091: дочерние строки и счёт остались привязаны — ни одного сироты', () => {
  const db = clinicBefore();
  apply091(db);

  assert.equal(db.prepare('SELECT admission_id a FROM admission_services WHERE id=1').get().a, 10);
  assert.equal(db.prepare('SELECT admission_id a FROM admission_transfers WHERE id=1').get().a, 10);
  assert.equal(db.prepare('SELECT admission_id a FROM admission_prescriptions WHERE id=1').get().a, 10);
  assert.equal(db.prepare('SELECT admission_id a FROM med_administrations WHERE id=1').get().a, 10);
  assert.equal(db.prepare('SELECT admission_id a FROM invoices WHERE id=1').get().a, 11);

  // Проверка самой базой, а не глазами: FK включены и ни одна ссылка не висит.
  assert.deepEqual(db.pragma('foreign_key_check'), [], 'после пересборки не должно остаться ни одного нарушения');
  db.close();
});

test('091: счётчик id не откатывается — удалённая госпитализация не отдаёт свой номер', () => {
  const db = clinicBefore();
  apply091(db);
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='admissions'").get().seq, 14);
  const next = db.prepare("INSERT INTO admissions (patient_id, status) VALUES (1,'ordered')").run().lastInsertRowid;
  assert.equal(next, 15, 'id №14 принадлежал удалённой строке и переиспользован быть не может');
  db.close();
});

test('091: новый CHECK принимает шесть состояний маршрута и отказывает всему прочему', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов')").run();
  const ins = db.prepare('INSERT INTO admissions (patient_id, status) VALUES (1, ?)');
  for (const s of NEW_STATUSES) ins.run(s);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admissions').get().n, NEW_STATUSES.length);

  for (const bad of ['requested', 'transferred', 'ACTIVE', '', 'ordered ']) {
    assert.throws(() => ins.run(bad), /CHECK constraint failed/, `статус «${bad}» должен быть отвергнут базой`);
  }
  db.close();
});

test('091: индексы на месте, включая новый (status, ward_id)', () => {
  const db = openDb(':memory:');
  migrate(db);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='admissions'").all().map((r) => r.name);
  for (const n of ['idx_admissions_status', 'idx_admissions_bed', 'idx_admissions_status_ward']) {
    assert.ok(idx.includes(n), 'нет индекса ' + n);
  }
  db.close();
});

test('091: у главного врача и старшей медсестры есть строка прав — иначе роль не видит ничего', () => {
  const db = openDb(':memory:');
  migrate(db);
  for (const role of ['head_doctor', 'senior_nurse']) {
    const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
    assert.ok(row, 'нет строки прав для роли ' + role);
    const perms = JSON.parse(row.permissions);
    assert.ok(Array.isArray(perms.sections) && perms.sections.includes('patients'),
      role + ': роль стационара обязана видеть карты пациентов');
  }
  db.close();
});

test('091: повторный прогон миграций — no-op (клиника обновляется дважды)', () => {
  const db = clinicBefore();
  apply091(db);
  migrate(db);   // 091 уже записана в schema_migrations — не должна примениться заново
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admissions').get().n, 4);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM role_permissions WHERE role='head_doctor'").get().n, 1);
  db.close();
});
