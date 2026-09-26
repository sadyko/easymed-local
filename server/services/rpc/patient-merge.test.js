// PATIENT_MERGE_SERVER_V1 — объединение дублей делает СЕРВЕР, одной транзакцией.
//
// Прежнее объединение шло из браузера таблица за таблицей, а реестр не даёт
// клиенту менять patient_id у визитов и счетов — дубль с визитами не
// объединялся вовсе: визиты оставались на нём, удаление карты падало на
// внешнем ключе. Здесь — дубль со всем, что бывает у живого пациента: визиты,
// услуги, анализы, счета, платежи, баланс, госпитализация с назначениями,
// давление, диагнозы, документы, родство, опекун, журнал, звонки, заявки.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createDeposit, acceptDeposit, depositBalance } from './deposits.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { openCashShift } from './cashier.js';
import { mergePatientsRpc, MERGE_TABLES } from './patient-merge.js';
import { getRpc } from './index.js';

const ADMIN = { id: 1, role: 'admin', full_name: 'Админ' };
const REG   = { id: 7, role: 'registrar', full_name: 'Каримова' };
const CASH  = { id: 9, role: 'cashier', full_name: 'Юлдашева' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (1,'a','x','Админ','admin')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (7,'r','x','Каримова','registrar')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (9,'c','x','Юлдашева','cashier')").run();
  const keep = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Иванов Иван', 1)").run().lastInsertRowid;
  const drop = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Иванов Иван', 1)").run().lastInsertRowid;
  const third = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Иванова Мария', 1)").run().lastInsertRowid;
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('ОАК', 100000)").run().lastInsertRowid;
  openCashShift(db, { opening_float: 0 }, CASH);
  return { db, keep, drop, third, svc };
}

// Всё, что бывает у живого пациента, — на карте дубля.
function fillDrop(db, { keep, drop, third, svc }) {
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(drop).lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,100000,100000,'added')").run(vid, svc).lastInsertRowid;
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (?, 'HGB', '140')").run(vs);
  const inv = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, REG).invoice;
  const { deposit } = createDeposit(db, { patient_id: drop, amount: 300000 }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  recordPayment(db, { invoice_id: inv.id, amount: 40000, method: 'wallet' }, CASH);
  recordPayment(db, { invoice_id: inv.id, amount: 60000, method: 'cash' }, CASH);
  const adm = db.prepare("INSERT INTO admissions (patient_id, status) VALUES (?, 'discharged')").run(drop).lastInsertRowid;
  db.prepare('INSERT INTO admission_prescriptions (admission_id, patient_id) VALUES (?, ?)').run(adm, drop);
  db.prepare('INSERT INTO patient_vitals (patient_id, visit_id, pulse_bpm) VALUES (?, ?, 70)').run(drop, vid);
  db.prepare("INSERT INTO patient_conditions (patient_id, label) VALUES (?, 'Гипертония')").run(drop);
  db.prepare("INSERT INTO visit_documents (patient_id, visit_id, title) VALUES (?, ?, 'Заключение')").run(drop, vid);
  db.prepare("INSERT INTO recommended_services (patient_id, service_id) VALUES (?, ?)").run(drop, svc);
  db.prepare("INSERT INTO patient_activity_log (patient_id, entity_type, action, summary) VALUES (?, 'visit', 'created', 'x')").run(drop);
  db.prepare("INSERT INTO patient_guardians (patient_id, guardian_patient_id, name) VALUES (?, ?, 'Мама')").run(drop, third);
  db.prepare("INSERT INTO patient_relationships (patient_id_a, patient_id_b, relation_type) VALUES (?, ?, 'sibling')").run(drop, third);
  db.prepare("INSERT INTO patient_relationships (patient_id_a, patient_id_b, relation_type) VALUES (?, ?, 'other')").run(keep, drop);
  return { vid, vs, inv, adm, depositId: deposit.id };
}

// Все колонки схемы, которые указывают на пациента.
function patientRefs(db) {
  const out = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (name === 'patients') continue;
    const cols = new Set(db.prepare(`PRAGMA foreign_key_list("${name}")`).all().filter((f) => f.table === 'patients').map((f) => f.from));
    for (const c of db.prepare(`PRAGMA table_info("${name}")`).all()) if (/(^|_)patient_id(_[ab])?$/.test(c.name)) cols.add(c.name);
    for (const c of cols) out.push(name + '.' + c);
  }
  return out.sort();
}

test('охват: каждая колонка схемы, указывающая на пациента, объединением обработана (новая таблица — провал здесь)', () => {
  const db = openDb(':memory:'); migrate(db);
  const handled = MERGE_TABLES.flatMap((t) => t.cols.map((c) => t.table + '.' + c)).sort();
  assert.deepEqual(patientRefs(db), handled);
  db.close();
});

test('дубль с визитами, анализами, счетами, платежами, балансом и госпитализацией — всё у оставленной карты, дубль удалён', () => {
  const ctx = seed();
  const { db, keep, drop, third } = ctx;
  const d = fillDrop(db, ctx);
  const balBefore = depositBalance(db, { patient_id: drop }, CASH).balance;
  const { deposit: kd } = createDeposit(db, { patient_id: keep, amount: 50000 }, REG);
  acceptDeposit(db, { deposit_id: kd.id, method: 'cash' }, CASH);

  const out = mergePatientsRpc(db, { keep_id: keep, drop_id: drop }, ADMIN);
  assert.equal(out.merged, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patients WHERE id = ?').get(drop).n, 0, 'карта дубля удалена');
  assert.equal(depositBalance(db, { patient_id: keep }, CASH).balance, 50000 + balBefore, 'баланс — сумма обоих');
  assert.equal(db.prepare('SELECT patient_id FROM visits WHERE id = ?').get(d.vid).patient_id, keep);
  assert.equal(db.prepare('SELECT patient_id FROM invoices WHERE id = ?').get(d.inv.id).patient_id, keep);
  assert.equal(db.prepare('SELECT patient_id FROM admissions WHERE id = ?').get(d.adm).patient_id, keep);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.patient_id = ?').get(keep).n, 4, 'два депозита (свой и дубля) + два платежа счёта дубля');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_results lr JOIN visit_services vs ON vs.id = lr.visit_service_id JOIN visits v ON v.id = vs.visit_id WHERE v.patient_id = ?').get(keep).n, 1);
  // Ничто в базе не указывает на дубль.
  for (const ref of patientRefs(db)) {
    const [t, c] = ref.split('.');
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE "${c}" = ?`).get(drop).n, 0, ref);
  }
  // Родство: ссылка «дубль — третий» перешла, «оставленная — дубль» стала бы связью с собой — снята.
  const rels = db.prepare('SELECT patient_id_a a, patient_id_b b FROM patient_relationships').all();
  assert.equal(rels.length, 1);
  assert.deepEqual([rels[0].a, rels[0].b].sort(), [keep, third].sort());
  // След в журнале карты.
  const log = db.prepare("SELECT * FROM patient_activity_log WHERE patient_id = ? AND action = 'merged'").get(keep);
  assert.ok(log, 'запись «объединено» в журнале карты');
  assert.match(log.summary, /Объединено/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM merge_money_moves').get().n, 0);
  db.close();
});

test('филиалы: переезд визитов и счетов и удаление дубля попадают в журнал синхронизации', () => {
  const ctx = seed();
  const { db, keep, drop } = ctx;
  const d = fillDrop(db, ctx);
  const puid = db.prepare('SELECT uid FROM patients WHERE id = ?').get(drop).uid;
  const vuid = db.prepare('SELECT uid FROM visits WHERE id = ?').get(d.vid).uid;
  db.prepare('DELETE FROM sync_journal').run();
  mergePatientsRpc(db, { keep_id: keep, drop_id: drop }, ADMIN);
  assert.ok(puid && vuid, 'у строк есть uid — журнал их везёт');
  assert.ok(db.prepare("SELECT 1 FROM sync_journal WHERE tbl = 'patients' AND uid = ? AND op = 'del'").get(puid), 'удаление дубля уедет');
  assert.ok(db.prepare("SELECT 1 FROM sync_journal WHERE tbl = 'visits' AND uid = ? AND cols LIKE '%patient_id%'").get(vuid), 'новый владелец визита уедет');
  db.close();
});

test('дубль из другого здания или с чужими строками — отказ по-русски, ничего не тронуто', () => {
  const ctx = seed();
  const { db, keep, drop } = ctx;
  const d = fillDrop(db, ctx);
  db.prepare("UPDATE visits SET sync_origin = 'B' WHERE id = ?").run(d.vid);
  assert.throws(() => mergePatientsRpc(db, { keep_id: keep, drop_id: drop }, ADMIN), (e) => e.status === 400 && /другого здания|филиал/.test(e.message));
  db.prepare('UPDATE visits SET sync_origin = NULL WHERE id = ?').run(d.vid);
  db.prepare("UPDATE patients SET sync_origin = 'B' WHERE id = ?").run(drop);
  assert.throws(() => mergePatientsRpc(db, { keep_id: keep, drop_id: drop }, ADMIN), /другого здания|филиал/);
  assert.equal(db.prepare('SELECT patient_id FROM visits WHERE id = ?').get(d.vid).patient_id, drop);
  db.close();
});

test('несколько дублей — одним вызовом и одной транзакцией: один чужой — не объединён никто', () => {
  const ctx = seed();
  const { db, keep, drop } = ctx;
  fillDrop(db, ctx);
  const drop2 = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Иванов И.', 1)").run().lastInsertRowid;
  const v2 = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(drop2).lastInsertRowid;
  db.prepare("UPDATE visits SET sync_origin = 'B' WHERE id = ?").run(v2);
  assert.throws(() => mergePatientsRpc(db, { keep_id: keep, drop_ids: [drop, drop2] }, ADMIN), /другого здания/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patients WHERE id IN (?, ?)').get(drop, drop2).n, 2, 'ни один дубль не тронут');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id = ?').get(drop).n > 0);
  db.prepare('UPDATE visits SET sync_origin = NULL WHERE id = ?').run(v2);
  const out = mergePatientsRpc(db, { keep_id: keep, drop_ids: [drop, drop2] }, ADMIN);
  assert.deepEqual(out.drop_ids, [drop, drop2]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patients WHERE id IN (?, ?)').get(drop, drop2).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id = ?').get(keep).n, 2);
  assert.throws(() => mergePatientsRpc(db, { keep_id: keep, drop_ids: [keep] }, ADMIN), (e) => e.status === 400);
  db.close();
});

test('права и проверки: только админ; сама с собой и несуществующая — отказ; прежней двери patient_merge_money нет', () => {
  const { db, keep, drop } = seed();
  assert.throws(() => mergePatientsRpc(db, { keep_id: keep, drop_id: drop }, CASH), (e) => e.status === 403);
  assert.throws(() => mergePatientsRpc(db, { keep_id: keep, drop_id: drop }, REG), (e) => e.status === 403);
  assert.throws(() => mergePatientsRpc(db, { keep_id: keep, drop_id: keep }, ADMIN), (e) => e.status === 400);
  assert.throws(() => mergePatientsRpc(db, { keep_id: keep, drop_id: 999 }, ADMIN), (e) => e.status === 400);
  assert.equal(typeof getRpc('merge_patients'), 'function');
  assert.ok(!getRpc('patient_merge_money'));
  db.close();
});
