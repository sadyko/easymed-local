// PATIENT_MERGE_BRANCHES_V1 — «объединять и по зданиям тоже» (решение
// владельца 2026-09-27).
//
// Проверяется обещание протокола на настоящих базах после всех миграций и на
// настоящем обмене (buildBatch → applyBatch → markSent), а не на подделанных
// записях:
//
//   1. Объединение, сделанное в A, исполняется в B целиком — включая то, что
//      между зданиями не ездит (баланс, госпитализации, давление, диагнозы,
//      документы, опекуны, журнал карты): всё у оставленной карты, дубль удалён,
//      отказов базы (sync_refused) нет, баланс в каждом здании — сумма обоих
//      его собственных.
//   2. Объединить можно и в здании, где карты не заведены (B объединяет карты
//      A) — дом карт исполняет событие.
//   3. Повтор порции ничего не меняет и ничего не ломает.
//   4. Событие раньше строк дубля: строки, приехавшие позже со ссылкой на
//      дубль, садятся на оставленную карту, сама карта-дубль не воскресает.
//   5. Надгробие дубля раньше оставленной карты: ничего не удаляется и не
//      отказывается, объединение исполняется, когда карта приезжает.
//   6. Эха нет: перенос, сделанный приёмником, не уезжает обратно.
//   7. Пустые контакты дополняет дом оставленной карты, и дополнение уезжает.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { buildBatch, markSent } from './journal.js';
import { applyBatch } from './records.js';
import { mergePatientsRpc } from '../rpc/patient-merge.js';
import { createDeposit, acceptDeposit, depositBalance } from '../rpc/deposits.js';
import { openCashShift } from '../rpc/cashier.js';
import { notePeerCaps, SYNC_CAPS, buildVersion } from './sync-caps.js';

const ADMIN = { id: 1, role: 'admin', full_name: 'Админ' };
const REG = { id: 7, role: 'registrar', full_name: 'Регистратор' };
const CASH = { id: 9, role: 'cashier', full_name: 'Касса' };

function house(letter) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('UPDATE branches SET letter = ? WHERE id = (SELECT MIN(id) FROM branches)').run(letter);
  db.prepare('UPDATE branch_identity SET letter = ? WHERE id = 1').run(letter);
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (1,'a','x','Админ','admin')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (7,'r','x','Регистратор','registrar')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (9,'c','x','Касса','cashier')").run();
  openCashShift(db, { opening_float: 0 }, CASH);
  return { db, letter };
}

/** Перевезти всё накопленное из одного здания в другое. */
function ship(from, to, { filter = null } = {}) {
  const batch = buildBatch(from.db, { self: from.letter, peer: to.letter, limit: 5000 });
  const records = filter ? batch.records.filter(filter) : batch.records;
  const stats = applyBatch(to.db, records, { self: to.letter, peer: from.letter, upto: batch.upto, seed: batch.seed });
  markSent(from.db, to.letter, batch.upto, batch.clock, batch.seed);
  return { batch, stats, records };
}

const patientByUid = (db, uid) => db.prepare('SELECT * FROM patients WHERE uid = ?').get(uid);
const uidOf = (db, id) => db.prepare('SELECT uid FROM patients WHERE id = ?').get(id).uid;
const idOf = (db, uid) => { const r = patientByUid(db, uid); return r ? r.id : null; };
const refused = (db) => db.prepare('SELECT COUNT(*) n FROM sync_refused').get().n;
const newPatient = (db, name, extra = {}) => {
  const cols = ['full_name', ...Object.keys(extra)];
  return db.prepare(`INSERT INTO patients (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(name, ...Object.values(extra)).lastInsertRowid;
};
const newVisit = (db, patientId) => db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'))")
  .run(patientId).lastInsertRowid;
function deposit(db, patientId, amount) {
  const { deposit: d } = createDeposit(db, { patient_id: patientId, amount }, REG);
  acceptDeposit(db, { deposit_id: d.id, method: 'cash' }, CASH);
}
const balance = (db, patientId) => depositBalance(db, { patient_id: patientId }, CASH).balance;

// Все местные строки, которые не ездят между зданиями, — на карте дубля.
function fillLocal(db, dropId, visitId, thirdId) {
  db.prepare("INSERT INTO admissions (patient_id, status) VALUES (?, 'discharged')").run(dropId);
  db.prepare('INSERT INTO patient_vitals (patient_id, visit_id, pulse_bpm) VALUES (?, ?, 72)').run(dropId, visitId);
  db.prepare("INSERT INTO patient_conditions (patient_id, label) VALUES (?, 'Астма')").run(dropId);
  db.prepare("INSERT INTO visit_documents (patient_id, visit_id, title) VALUES (?, ?, 'Выписка')").run(dropId, visitId);
  db.prepare("INSERT INTO patient_guardians (patient_id, guardian_patient_id, name) VALUES (?, ?, 'Мама')").run(dropId, thirdId);
  db.prepare("INSERT INTO patient_activity_log (patient_id, entity_type, action, summary) VALUES (?, 'visit', 'created', 'x')").run(dropId);
}

function assertNothingOn(db, dropId) {
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (name === 'patients') continue;
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name).filter((c) => /(^|_)patient_id(_[ab])?$/.test(c));
    for (const c of cols) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM "${name}" WHERE "${c}" = ?`).get(dropId).n, 0, `${name}.${c} ещё указывает на дубль`);
    }
  }
}

test('объединение в A исполняется в B: местные строки B (баланс, госпитализация, давление, документы, опекун) — у оставленной карты, дубль удалён, отказов нет', () => {
  const A = house('A'); const B = house('B');
  const keepA = newPatient(A.db, 'Иванов Иван');
  const dropA = newPatient(A.db, 'Иванов Иван');
  const thirdA = newPatient(A.db, 'Иванова Мария');
  newVisit(A.db, dropA);
  deposit(A.db, dropA, 100000);
  deposit(A.db, keepA, 20000);
  ship(A, B);
  const keepUid = uidOf(A.db, keepA); const dropUid = uidOf(A.db, dropA);
  const keepB = idOf(B.db, keepUid); const dropB = idOf(B.db, dropUid); const thirdB = idOf(B.db, uidOf(A.db, thirdA));
  assert.ok(keepB && dropB && thirdB, 'обе карты доехали до B');

  // В B у дубля своя жизнь: визит, баланс, госпитализация, давление, документ, опекун.
  const vB = newVisit(B.db, dropB);
  deposit(B.db, dropB, 300000);
  deposit(B.db, keepB, 50000);
  fillLocal(B.db, dropB, vB, thirdB);
  ship(B, A);   // визит B доезжает до A

  mergePatientsRpc(A.db, { keep_id: keepA, drop_id: dropA }, ADMIN);
  assert.equal(balance(A.db, keepA), 120000, 'в A баланс — сумма двух своих');

  const { stats } = ship(A, B);
  assert.equal(stats.merged, 1, 'B исполнил событие');
  assert.equal(refused(B.db), 0, 'ни одного отказа базы в B');
  assert.equal(idOf(B.db, dropUid), null, 'дубль удалён и в B');
  assert.equal(idOf(B.db, keepUid), keepB);
  assertNothingOn(B.db, dropB);
  assert.equal(balance(B.db, keepB), 350000, 'в B баланс — сумма двух своих');
  assert.equal(B.db.prepare('SELECT patient_id FROM visits WHERE id = ?').get(vB).patient_id, keepB);
  assert.equal(B.db.prepare('SELECT COUNT(*) n FROM admissions WHERE patient_id = ?').get(keepB).n, 1);
  assert.equal(B.db.prepare('SELECT COUNT(*) n FROM patient_vitals WHERE patient_id = ?').get(keepB).n, 1);
  assert.equal(B.db.prepare('SELECT COUNT(*) n FROM visit_documents WHERE patient_id = ?').get(keepB).n, 1);
  assert.equal(B.db.prepare('SELECT COUNT(*) n FROM patient_guardians WHERE patient_id = ?').get(keepB).n, 1);
  const log = B.db.prepare("SELECT * FROM patient_activity_log WHERE patient_id = ? AND action = 'merged'").get(keepB);
  assert.ok(log && /здании A/.test(log.summary), 'в журнале карты B видно, откуда пришло объединение');
  assert.equal(B.db.prepare('SELECT COUNT(*) n FROM merge_money_moves').get().n, 0);

  // Эха нет: B не везёт обратно ни перенос, ни удаление, ни событие.
  const back = buildBatch(B.db, { self: 'B', peer: 'A', limit: 5000 }).records;
  assert.deepEqual(back.filter((r) => ['patients', 'visits', 'invoices', 'patient_merges'].includes(r.tbl)), [], 'обратно ничего не уезжает');
  ship(B, A);
  assert.equal(refused(A.db), 0);
  assert.equal(A.db.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id = ?').get(keepA).n, 2, 'в A оба визита на оставленной карте');
});

test('объединение в B карт, заведённых в A: дом карт (A) исполняет событие, его баланс и госпитализации переезжают', () => {
  const A = house('A'); const B = house('B');
  const keepA = newPatient(A.db, 'Петров Пётр');
  const dropA = newPatient(A.db, 'Петров П.');
  const vA = newVisit(A.db, dropA);
  deposit(A.db, dropA, 70000);
  A.db.prepare("INSERT INTO admissions (patient_id, status) VALUES (?, 'discharged')").run(dropA);
  ship(A, B);
  const keepUid = uidOf(A.db, keepA); const dropUid = uidOf(A.db, dropA);

  const out = mergePatientsRpc(B.db, { keep_id: idOf(B.db, keepUid), drop_id: idOf(B.db, dropUid) }, ADMIN);
  assert.equal(out.merged, true, 'карту, заведённую в другом здании, объединить можно');

  const { stats } = ship(B, A);
  assert.equal(stats.merged, 1);
  assert.equal(refused(A.db), 0, 'надгробие дубля не упало на внешнем ключе');
  assert.equal(idOf(A.db, dropUid), null);
  assertNothingOn(A.db, dropA);
  assert.equal(balance(A.db, keepA), 70000);
  assert.equal(A.db.prepare('SELECT patient_id FROM visits WHERE id = ?').get(vA).patient_id, keepA);
  assert.equal(A.db.prepare('SELECT COUNT(*) n FROM admissions WHERE patient_id = ?').get(keepA).n, 1);
});

test('повтор порции: второе применение ничего не меняет и не отказывает', () => {
  const A = house('A'); const B = house('B');
  const keepA = newPatient(A.db, 'Сидоров');
  const dropA = newPatient(A.db, 'Сидоров');
  newVisit(A.db, dropA);
  ship(A, B);
  const keepUid = uidOf(A.db, keepA); const dropUid = uidOf(A.db, dropA);
  deposit(B.db, idOf(B.db, dropUid), 10000);
  mergePatientsRpc(A.db, { keep_id: keepA, drop_id: dropA }, ADMIN);
  const batch = buildBatch(A.db, { self: 'A', peer: 'B', limit: 5000 });
  applyBatch(B.db, batch.records, { self: 'B', peer: 'A', upto: batch.upto });
  const snap = () => ({
    patients: B.db.prepare('SELECT COUNT(*) n FROM patients').get().n,
    merges: B.db.prepare('SELECT COUNT(*) n FROM patient_merges').get().n,
    log: B.db.prepare("SELECT COUNT(*) n FROM patient_activity_log WHERE action = 'merged'").get().n,
    bal: balance(B.db, idOf(B.db, keepUid)),
  });
  const first = snap();
  // Тот же срез ещё раз — без квитанции (как если бы она не дошла), чтобы
  // приёмник действительно разобрал записи заново, а не отсёк повтор.
  const again = applyBatch(B.db, batch.records, { self: 'B' });
  assert.equal(again.merged, 0);
  assert.deepEqual(snap(), first);
  assert.equal(first.bal, 10000);
  assert.equal(idOf(B.db, dropUid), null);
  assert.equal(refused(B.db), 0);
});

test('событие раньше строк дубля: визит третьего здания на дубль садится на оставленную карту, дубль не воскресает', () => {
  const A = house('A'); const B = house('B'); const C = house('C');
  // Дубль заведён в B вместе с визитом; оставленная карта — в A.
  const dropB = newPatient(B.db, 'Каримов');
  const vB = newVisit(B.db, dropB);
  const dropUid = uidOf(B.db, dropB);
  const vUid = B.db.prepare('SELECT uid FROM visits WHERE id = ?').get(vB).uid;
  const keepA = newPatient(A.db, 'Каримов');
  const keepUid = uidOf(A.db, keepA);
  ship(B, A);
  mergePatientsRpc(A.db, { keep_id: keepA, drop_id: idOf(A.db, dropUid) }, ADMIN);
  // B о слиянии ещё не знает и заводит дублю новый визит.
  const vB2 = newVisit(B.db, dropB);
  const v2Uid = B.db.prepare('SELECT uid FROM visits WHERE id = ?').get(vB2).uid;
  // C узнаёт о слиянии от A раньше, чем получит что-либо от B.
  ship(A, C);
  assert.ok(C.db.prepare('SELECT 1 FROM patient_merges WHERE drop_uid = ?').get(dropUid));
  const { stats } = ship(B, C);   // карта-дубль и её визиты — теперь
  assert.equal(refused(C.db), 0);
  assert.equal(idOf(C.db, dropUid), null, 'дубль не заведён заново');
  const keepC = idOf(C.db, keepUid);
  for (const u of [vUid, v2Uid]) {
    const v = C.db.prepare('SELECT patient_id FROM visits WHERE uid = ?').get(u);
    assert.ok(v, 'визит дубля доехал');
    assert.equal(v.patient_id, keepC, 'и сел на оставленную карту');
  }
  assert.equal(C.db.prepare('SELECT COUNT(*) n FROM sync_pending').get().n, 0, 'в ожидании ничего не осталось');
  assert.ok(stats.skipped >= 1);
  // И сам B, узнав о слиянии, переносит свой новый визит.
  ship(A, B);
  assert.equal(idOf(B.db, dropUid), null);
  assert.equal(B.db.prepare('SELECT patient_id FROM visits WHERE id = ?').get(vB2).patient_id, idOf(B.db, keepUid));
  assert.equal(refused(B.db), 0);
});

test('надгробие дубля раньше оставленной карты: ничего не удаляется и не отказывается, объединение — когда карта приехала', () => {
  const A = house('A'); const B = house('B'); const C = house('C');
  const dropB = newPatient(B.db, 'Юсупов');
  const dropUid = uidOf(B.db, dropB);
  ship(B, C);
  const dropC = idOf(C.db, dropUid);
  deposit(C.db, dropC, 40000);
  C.db.prepare("INSERT INTO admissions (patient_id, status) VALUES (?, 'discharged')").run(dropC);
  const keepA = newPatient(A.db, 'Юсупов');
  const keepUid = uidOf(A.db, keepA);
  ship(B, A);
  mergePatientsRpc(A.db, { keep_id: keepA, drop_id: idOf(A.db, dropUid) }, ADMIN);
  // Порция A доезжает до C без самой оставленной карты (обгон/потеря порядка).
  const { records } = ship(A, C, { filter: (r) => !(r.tbl === 'patients' && r.uid === keepUid) });
  assert.ok(records.some((r) => r.tbl === 'patients' && r.uid === dropUid && r.op === 'del'), 'надгробие дубля в порции есть');
  assert.equal(refused(C.db), 0, 'надгробие не упало на внешнем ключе');
  assert.equal(idOf(C.db, dropUid), dropC, 'дубль с местными строками на месте — ждёт оставленную карту');
  assert.equal(balance(C.db, dropC), 40000);
  // Приезжает оставленная карта (правка на A поднимает её в журнал).
  A.db.prepare("UPDATE patients SET notes = 'VIP' WHERE id = ?").run(keepA);
  const { stats } = ship(A, C);
  assert.equal(stats.merged, 1);
  const keepC = idOf(C.db, keepUid);
  assert.ok(keepC);
  assert.equal(idOf(C.db, dropUid), null);
  assert.equal(balance(C.db, keepC), 40000);
  assert.equal(C.db.prepare('SELECT COUNT(*) n FROM admissions WHERE patient_id = ?').get(keepC).n, 1);
  assert.equal(refused(C.db), 0);
});

test('открытые госпитализации в двух зданиях: приёмник не отказывает, а отмечает в журнале карты', () => {
  const A = house('A'); const B = house('B');
  const keepA = newPatient(A.db, 'Алиев');
  const dropA = newPatient(A.db, 'Алиев');
  ship(A, B);
  const keepUid = uidOf(A.db, keepA); const dropUid = uidOf(A.db, dropA);
  const keepB = idOf(B.db, keepUid);
  B.db.prepare("INSERT INTO admissions (patient_id, status) VALUES (?, 'admitted')").run(keepB);
  B.db.prepare("INSERT INTO admissions (patient_id, status) VALUES (?, 'active')").run(idOf(B.db, dropUid));
  mergePatientsRpc(A.db, { keep_id: keepA, drop_id: dropA }, ADMIN);   // в A госпитализаций нет — можно
  ship(A, B);
  assert.equal(idOf(B.db, dropUid), null);
  assert.equal(B.db.prepare('SELECT COUNT(*) n FROM admissions WHERE patient_id = ?').get(keepB).n, 2);
  const log = B.db.prepare("SELECT summary FROM patient_activity_log WHERE patient_id = ? AND action = 'merged'").get(keepB);
  assert.match(log.summary, /две открытые госпитализации/);
});

test('контакты: пустые поля оставленной карты дополняет её дом, и дополнение уезжает обратно', () => {
  const A = house('A'); const B = house('B');
  const keepB = newPatient(B.db, 'Рахимов');
  const keepUid = uidOf(B.db, keepB);
  ship(B, A);
  const dropA = newPatient(A.db, 'Рахимов', { email: 'r@x.uz', phone: '+998901112233' });
  const dropUid = uidOf(A.db, dropA);
  ship(A, B);
  mergePatientsRpc(A.db, { keep_id: idOf(A.db, keepUid), drop_id: dropA }, ADMIN);
  assert.ok(!patientByUid(A.db, keepUid).email, 'чужую карту A не правит');
  ship(A, B);
  assert.equal(idOf(B.db, dropUid), null);
  assert.equal(patientByUid(B.db, keepUid).email, 'r@x.uz', 'дом карты дополнил пустой email');
  assert.equal(patientByUid(B.db, keepUid).phone_secondary, '+998901112233');
  ship(B, A);
  assert.equal(patientByUid(A.db, keepUid).email, 'r@x.uz', 'дополнение доехало до A');
});

test('цепочка: D слита в K, потом K — в K2; приёмник, получивший обе, собирает всё на K2', () => {
  const A = house('A'); const B = house('B');
  const k2 = newPatient(A.db, 'Н'); const k = newPatient(A.db, 'Н'); const d = newPatient(A.db, 'Н');
  ship(A, B);
  const [k2u, ku, du] = [k2, k, d].map((id) => uidOf(A.db, id));
  deposit(B.db, idOf(B.db, du), 1000);
  deposit(B.db, idOf(B.db, ku), 2000);
  mergePatientsRpc(A.db, { keep_id: k, drop_id: d }, ADMIN);
  mergePatientsRpc(A.db, { keep_id: k2, drop_id: k }, ADMIN);
  ship(A, B);
  assert.equal(idOf(B.db, du), null);
  assert.equal(idOf(B.db, ku), null);
  assert.equal(balance(B.db, idOf(B.db, k2u)), 3000);
  assert.equal(refused(B.db), 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// FINAL_ROLES_SYNC_FIX_V1 (I3) — ВСТРЕЧНЫЕ ОБЪЕДИНЕНИЯ ОДНОЙ ПАРЫ.
//
// A слил X в Y, B между обменами — Y в X. Раньше A оставлял Y, B — X, обе
// карты числились «слитыми» (mergedAway) в обоих зданиях, и любая правка карты
// пропускалась навсегда. Теперь спор решается одинаково в каждом здании:
// побеждает самое раннее событие (merged_at, uid); встречное, замыкающее круг,
// не исполняется; проигравшая сторона возвращает оставленную карту (её строка
// становится картой-победителем), здание-победитель дошлёт её поля.
// ═══════════════════════════════════════════════════════════════════════════
// Время события задаётся тестом (порядок сторон круга должен быть известен).
// Правка merged_at — не часть протокола: её журнальная запись снимается, чтобы
// событие ехало на своём месте, раньше надгробия дубля, как в жизни.
const setMergedAt = (db, dropUid, at) => {
  db.prepare('UPDATE patient_merges SET merged_at = ? WHERE drop_uid = ?').run(at, dropUid);
  db.prepare("DELETE FROM sync_journal WHERE tbl = 'patient_merges' AND cols = 'merged_at'").run();
};
const mergeLog = (db, id) => db.prepare("SELECT summary FROM patient_activity_log WHERE patient_id = ? AND action = 'merge_conflict'").all(id);

function oppositePair() {
  const A = house('A'); const B = house('B');
  const x = newPatient(A.db, 'Иванов И.', { phone: '+998900000001' });
  const y = newPatient(A.db, 'Иванов Иван', { phone: '+998900000002' });
  ship(A, B);
  const xu = uidOf(A.db, x); const yu = uidOf(A.db, y);
  // Своя жизнь у обеих карт в B: визит и деньги.
  const vB = newVisit(B.db, idOf(B.db, xu));
  deposit(B.db, idOf(B.db, xu), 5000);
  deposit(B.db, idOf(B.db, yu), 7000);
  deposit(A.db, x, 1000);
  // Между обменами: A оставляет Y (раньше), B оставляет X (позже).
  mergePatientsRpc(A.db, { keep_id: y, drop_id: x }, ADMIN);
  setMergedAt(A.db, xu, '2026-09-27T10:00:00Z');
  mergePatientsRpc(B.db, { keep_id: idOf(B.db, xu), drop_id: idOf(B.db, yu) }, ADMIN);
  setMergedAt(B.db, yu, '2026-09-27T10:00:05Z');
  return { A, B, xu, yu, vB };
}

test('I3: встречные объединения пары в двух зданиях — оба оставляют раннюю сторону, правки карты снова ездят', () => {
  const { A, B, xu, yu, vB } = oppositePair();
  ship(A, B); ship(B, A); ship(A, B); ship(B, A);

  for (const H of [A, B]) {
    assert.ok(idOf(H.db, yu), H.letter + ': оставленная карта (ранний победитель) Y есть');
    assert.equal(idOf(H.db, xu), null, H.letter + ': X слита');
    assert.equal(refused(H.db), 0, H.letter + ': отказов базы нет');
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM sync_pending').get().n, 0);
  }
  const yB = idOf(B.db, yu);
  assert.equal(B.db.prepare('SELECT patient_id FROM visits WHERE id = ?').get(vB).patient_id, yB, 'визит B — на оставленной карте');
  assert.equal(balance(B.db, yB), 12000, 'баланс B — сумма двух своих');
  assert.equal(balance(A.db, idOf(A.db, yu)), 1000);
  assert.equal(patientByUid(B.db, yu).full_name, 'Иванов Иван', 'поля карты B — поля победителя (дослал A)');
  assert.equal(patientByUid(B.db, yu).phone, '+998900000002');
  assert.ok(mergeLog(B.db, yB).length >= 1, 'встречное объединение записано в журнал карты B');
  assert.ok(mergeLog(A.db, idOf(A.db, yu)).length >= 1, 'и в журнал карты A');

  // Правки карты снова ездят — в обе стороны.
  A.db.prepare("UPDATE patients SET notes = 'из A' WHERE uid = ?").run(yu);
  ship(A, B);
  assert.equal(patientByUid(B.db, yu).notes, 'из A');
  B.db.prepare("UPDATE patients SET address = 'Ташкент' WHERE uid = ?").run(yu);
  ship(B, A);
  assert.equal(patientByUid(A.db, yu).address, 'Ташкент');
  // Повтор ничего не меняет и не пишет второй раз в журнал карты.
  const n = mergeLog(B.db, yB).length;
  ship(A, B); ship(B, A);
  assert.equal(mergeLog(B.db, yB).length, n);
});

test('I3: третье здание получает встречные события в любом порядке — итог тот же', () => {
  for (const order of ['BA', 'AB']) {
    const A = house('A'); const B = house('B'); const C = house('C');
    const x = newPatient(A.db, 'Сидоров С.');
    const y = newPatient(A.db, 'Сидоров Сидор');
    ship(A, B); ship(A, C);
    const xu = uidOf(A.db, x); const yu = uidOf(A.db, y);
    deposit(C.db, idOf(C.db, xu), 3000);
    deposit(C.db, idOf(C.db, yu), 4000);
    mergePatientsRpc(A.db, { keep_id: y, drop_id: x }, ADMIN);
    setMergedAt(A.db, xu, '2026-09-27T10:00:00Z');
    mergePatientsRpc(B.db, { keep_id: idOf(B.db, xu), drop_id: idOf(B.db, yu) }, ADMIN);
    setMergedAt(B.db, yu, '2026-09-27T10:00:05Z');
    if (order === 'BA') { ship(B, C); ship(A, C); } else { ship(A, C); ship(B, C); }
    ship(A, B); ship(B, A); ship(A, C); ship(B, C);
    for (const H of [A, B, C]) {
      assert.ok(idOf(H.db, yu), order + ' ' + H.letter + ': Y жива');
      assert.equal(idOf(H.db, xu), null, order + ' ' + H.letter + ': X слита');
      assert.equal(refused(H.db), 0);
    }
    assert.equal(balance(C.db, idOf(C.db, yu)), 7000, order + ': баланс C — сумма двух своих');
    assert.equal(patientByUid(C.db, yu).full_name, 'Сидоров Сидор', order + ': поля C — победителя');
    A.db.prepare("UPDATE patients SET notes = 'VIP' WHERE uid = ?").run(yu);
    ship(A, C); ship(A, B);
    assert.equal(patientByUid(C.db, yu).notes, 'VIP', order + ': правка доезжает до C');
    assert.equal(patientByUid(B.db, yu).notes, 'VIP', order + ': и до B');
  }
});

// M7 — событие, чья оставленная карта удалена у себя дома: дубль не замерзает.
test('M7: оставленная карта удалена (надгробие) — событие не исполняется, дубль остаётся живой картой', () => {
  const A = house('A'); const B = house('B'); const C = house('C');
  const k = newPatient(A.db, 'Каримова');
  const d = newPatient(A.db, 'Каримова Д.');
  ship(A, B); ship(A, C);
  const ku = uidOf(A.db, k); const du = uidOf(A.db, d);
  deposit(C.db, idOf(C.db, du), 9000);
  // B сливает D в K; A (дом K) тем временем удаляет пустую K.
  mergePatientsRpc(B.db, { keep_id: idOf(B.db, ku), drop_id: idOf(B.db, du) }, ADMIN);
  A.db.prepare('DELETE FROM patients WHERE id = ?').run(k);
  ship(A, C);            // надгробие K
  assert.equal(idOf(C.db, ku), null);
  ship(B, C);            // событие D→K и надгробие D
  const dC = idOf(C.db, du);
  assert.ok(dC, 'дубль с местными деньгами на месте');
  assert.equal(balance(C.db, dC), 9000);
  assert.equal(refused(C.db), 0);
  // И не заморожен: правка из дома D доезжает.
  A.db.prepare("UPDATE patients SET notes = 'жива' WHERE id = ?").run(d);
  ship(A, C);
  assert.equal(patientByUid(C.db, du).notes, 'жива', 'правка карты, чья пара удалена, пропущена — карта замёрзла');
});

// ═══════════════════════════════════════════════════════════════════════════
// FINAL_ROLES_SYNC_FIX_V1 (I4) — СОСЕД СТАРОЙ СБОРКИ.
//
// Здание без миграции 168 событие объединения пропускает (неизвестная таблица)
// и подтверждает приём — событие потеряно, а надгробие дубля у него падает на
// внешнем ключе или стирает журнал карты. Поэтому каждая выгрузка журнала
// несёт умения сборки (caps), приёмник пишет их в sync_peers (мигр. 185), и
// объединение карты, которая уже есть у соседа без умения merge_events,
// отказывается по-русски. Карта, ещё никуда не уехавшая, объединяется.
// ═══════════════════════════════════════════════════════════════════════════
const addBuilding = (db, letter, name) => db.prepare('INSERT INTO branches (name, letter, active) VALUES (?, ?, 1)').run(name, letter);

test('I4: сосед не заявил merge_events — карту, уехавшую к нему, не объединяем; своя неуехавшая — объединяется', () => {
  const A = house('A'); const B = house('B');
  addBuilding(A.db, 'B', 'Филиал Чиланзар');
  const keep = newPatient(A.db, 'Турсунов');
  const drop = newPatient(A.db, 'Турсунов Т.');
  ship(A, B);   // обе карты уехали в B (старой сборки: caps не присылал)
  const before = A.db.prepare('SELECT COUNT(*) n FROM patients').get().n;
  assert.throws(() => mergePatientsRpc(A.db, { keep_id: keep, drop_id: drop }, ADMIN), (e) =>
    e.status === 409 && e.message.includes('Обновите все здания до версии ' + buildVersion())
    && /которая уже есть в другом здании/.test(e.message) && /Филиал Чиланзар \(B\)/.test(e.message));
  assert.equal(A.db.prepare('SELECT COUNT(*) n FROM patients').get().n, before, 'отказ ничего не тронул');
  assert.equal(A.db.prepare('SELECT COUNT(*) n FROM patient_merges').get().n, 0, 'событие не заведено');

  // Своя карта, ещё не выложенная соседу, объединяется: событие о ней некому терять.
  const k2 = newPatient(A.db, 'Новый'); const d2 = newPatient(A.db, 'Новый');
  assert.equal(mergePatientsRpc(A.db, { keep_id: k2, drop_id: d2 }, ADMIN).merged, true);

  // Карта, пришедшая из другого здания, — есть в сети: тоже ждёт обновления.
  const fromB = newPatient(B.db, 'Из B'); const fromB2 = newPatient(B.db, 'Из B');
  ship(B, A);
  assert.throws(() => mergePatientsRpc(A.db, { keep_id: idOf(A.db, uidOf(B.db, fromB)), drop_id: idOf(A.db, uidOf(B.db, fromB2)) }, ADMIN),
    (e) => e.status === 409);

  // Сосед обновился и сказал об этом в выгрузке — объединение проходит и доезжает.
  notePeerCaps(A.db, 'B', { caps: [...SYNC_CAPS], app_version: buildVersion() });
  assert.equal(mergePatientsRpc(A.db, { keep_id: keep, drop_id: drop }, ADMIN).merged, true);
  ship(A, B);
  assert.equal(idOf(B.db, uidOf(A.db, keep)) != null, true);
  assert.equal(B.db.prepare('SELECT COUNT(*) n FROM patient_merges').get().n, 2);

  // Откат сборки у соседа (выгрузка без caps) снова закрывает объединение уехавших карт.
  notePeerCaps(A.db, 'B', { app_version: '3.9.0' });
  const k3 = newPatient(A.db, 'Ещё'); const d3 = newPatient(A.db, 'Ещё');
  ship(A, B);
  assert.throws(() => mergePatientsRpc(A.db, { keep_id: k3, drop_id: d3 }, ADMIN), (e) => e.status === 409);
});
