// PATIENT_AGGREGATES_V1 — числа картотеки: визиты, последний визит, баланс,
// страховка, регистратор. RPC не существовало вовсе (501), и картотека у
// КАЖДОГО пациента показывала «визитов не было» и «0 сум» — молча и похоже на
// правду.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { patientBaseAggregates } from './patient-aggregates.js';
import { RpcError } from './inpatient-flow.js';
import { isReadOnlyRpc } from '../control/gate.js';

const registrar = { id: 2, role: 'registrar' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'reg','x','Ахмедова Нигора','registrar')").run();
  const payer = db.prepare("INSERT INTO payers (name, kind) VALUES ('Страховая А','insurance')").run().lastInsertRowid;
  const p1 = db.prepare("INSERT INTO patients (full_name, mrn, date_of_birth, gender, payer_id, created_by) VALUES ('Каримов Темур','31002','1971-07-03','male',?,2)").run(payer).lastInsertRowid;
  const p2 = db.prepare("INSERT INTO patients (full_name, mrn, date_of_birth, gender) VALUES ('Юлдашев Сардор','27431','1985-03-30','male')").run().lastInsertRowid;
  return { db, p1, p2 };
}

test('визиты считаются, последний визит — самый поздний', () => {
  const { db, p1, p2 } = seed();
  try {
    for (const d of ['2026-06-01T09:00:00Z', '2026-07-15T10:30:00Z', '2026-05-02T08:00:00Z']) {
      db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (?,?,?)').run(p1, d, 'arrived');
    }
    const rows = patientBaseAggregates(db, { p_ids: [p1, p2] }, registrar);
    const a = rows.find((r) => r.patient_id === p1);
    const b = rows.find((r) => r.patient_id === p2);
    assert.equal(a.visit_count, 3);
    assert.equal(String(a.last_visit).slice(0, 10), '2026-07-15');
    assert.equal(b.visit_count, 0, 'у пациента без визитов — ноль, а не пустота');
    assert.equal(b.last_visit, null);
  } finally { db.close(); }
});

test('баланс — оплачено минус выставлено; отменённый счёт не считается долгом', () => {
  const { db, p1 } = seed();
  try {
    db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, paid_amount, status) VALUES ('INV-1',?,500000,500000,200000,'partial')").run(p1);
    db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, paid_amount, status) VALUES ('INV-2',?,300000,300000,0,'void')").run(p1);
    const [a] = patientBaseAggregates(db, { p_ids: [p1] }, registrar);
    assert.equal(a.balance, -300000, 'долг 300 000 — и ровно он, отменённый счёт мимо');
  } finally { db.close(); }
});

test('страховка, её вид и регистратор приходят именами, а не идентификаторами', () => {
  const { db, p1, p2 } = seed();
  try {
    const rows = patientBaseAggregates(db, { p_ids: [p1, p2] }, registrar);
    const a = rows.find((r) => r.patient_id === p1);
    const b = rows.find((r) => r.patient_id === p2);
    assert.equal(a.insurer, 'Страховая А');
    assert.equal(a.payer_type, 'insurance');
    assert.equal(a.registrar, 'Ахмедова Нигора');
    assert.equal(b.insurer, '', 'без плательщика — пустая строка, экран сам напишет прочерк');
    assert.equal(b.registrar, '');
  } finally { db.close(); }
});

test('пустой список — пустой ответ, а не вся картотека', () => {
  const { db } = seed();
  try {
    assert.deepEqual(patientBaseAggregates(db, { p_ids: [] }, registrar), []);
    assert.deepEqual(patientBaseAggregates(db, {}, registrar), []);
  } finally { db.close(); }
});

test('роль без картотеки получает отказ, а чтение разрешено при просроченной лицензии', () => {
  const { db, p1 } = seed();
  try {
    assert.throws(() => patientBaseAggregates(db, { p_ids: [p1] }, { id: 9, role: 'inventory' }),
      (e) => e instanceof RpcError && e.status === 403);
    assert.ok(isReadOnlyRpc('patient_base_aggregates'), 'это чтение — клиника обязана видеть картотеку и с просроченной лицензией');
  } finally { db.close(); }
});
