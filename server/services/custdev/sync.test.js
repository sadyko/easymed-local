// CUSTDEV_V1 — кто попадает на доску, с чьими именами, и что будет при повторе.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { syncCards } from './sync.js';

// Локальная дата со сдвигом в днях — теми же местными сутками, что и код.
const dayOffset = (db, n) => db.prepare("SELECT date('now','localtime',? || ' days') d").get(String(n)).d;

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(10, 'reg', 'x', 'Регистратор Р.', 'registrar');
  u.run(11, 'cash', 'x', 'Кассир К.', 'cashier');
  u.run(12, 'doc', 'x', 'Врач В.', 'doctor');
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (1, 'Иванов И.', '+998900000000')").run();
  return db;
}

// Пришёл, счёт оплачен, деньги приняты — полный «хороший» визит.
function paidVisit(db, { id, day, doctorId = 12, paid = 50000, status = 'paid' }) {
  db.prepare('INSERT INTO visits (id, patient_id, doctor_id, visit_date, status) VALUES (?,1,?,?,?)')
    .run(id, doctorId, day + 'T09:00:00Z', 'arrived');
  db.prepare('INSERT INTO invoices (id, visit_id, patient_id, total_amount, paid_amount, status, created_by) VALUES (?,?,1,?,?,?,10)')
    .run(id, id, paid, paid, status);
  db.prepare('INSERT INTO payments (invoice_id, amount, cashier_id) VALUES (?,?,11)').run(id, paid);
}

const wide = (db) => ({ from: dayOffset(db, -30), to: dayOffset(db, 0) });

test('вчерашний оплаченный визит попадает на доску со снимком сотрудников', () => {
  const db = fresh();
  paidVisit(db, { id: 1, day: dayOffset(db, -1) });

  const created = syncCards(db, wide(db));
  assert.equal(created, 1);

  const c = db.prepare('SELECT * FROM custdev_cards WHERE visit_id = 1').get();
  assert.equal(c.patient_id, 1);
  assert.equal(c.registrar_id, 10, 'регистратор — тот, кто составил счёт');
  assert.equal(c.cashier_id, 11, 'кассир — тот, кто принял платёж');
  assert.equal(c.doctor_id, 12);
  assert.equal(c.paid_amount, 50000);
  assert.equal(c.status, 'new');
});

test('сегодняшний визит карточку НЕ создаёт — звоним на следующий день', () => {
  const db = fresh();
  paidVisit(db, { id: 1, day: dayOffset(db, 0) });
  assert.equal(syncCards(db, wide(db)), 0);
});

test('не пришёл или не оплатил — карточки нет', () => {
  const db = fresh();
  const yesterday = dayOffset(db, -1);

  // Записан, но не пришёл.
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (2,1,?,'no_show')").run(yesterday + 'T09:00:00Z');
  db.prepare("INSERT INTO invoices (id, visit_id, patient_id, paid_amount, status, created_by) VALUES (2,2,1,50000,'paid',10)").run();

  // Пришёл, но счёт не оплачен.
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (3,1,?,'arrived')").run(yesterday + 'T09:00:00Z');
  db.prepare("INSERT INTO invoices (id, visit_id, patient_id, paid_amount, status, created_by) VALUES (3,3,1,0,'unpaid',10)").run();

  assert.equal(syncCards(db, wide(db)), 0);
});

test('частичная оплата считается оплатой — деньги клиника получила', () => {
  const db = fresh();
  paidVisit(db, { id: 4, day: dayOffset(db, -1), paid: 20000, status: 'partial' });
  assert.equal(syncCards(db, wide(db)), 1);
});

test('визит без своего врача берёт врача из услуг', () => {
  const db = fresh();
  const day = dayOffset(db, -2);
  paidVisit(db, { id: 5, day, doctorId: null });
  db.prepare('INSERT INTO visit_services (visit_id, service_id, doctor_id) VALUES (5, NULL, 12)').run();

  syncCards(db, wide(db));
  assert.equal(db.prepare('SELECT doctor_id FROM custdev_cards WHERE visit_id = 5').get().doctor_id, 12);
});

test('лабораторный визит вообще без врача — карточка есть, врач пуст', () => {
  const db = fresh();
  paidVisit(db, { id: 6, day: dayOffset(db, -1), doctorId: null });
  syncCards(db, wide(db));
  const c = db.prepare('SELECT * FROM custdev_cards WHERE visit_id = 6').get();
  assert.equal(c.doctor_id, null, 'именно для этого случая существует оценка «Не применимо»');
});

test('повторный прогон не создаёт дублей', () => {
  const db = fresh();
  paidVisit(db, { id: 7, day: dayOffset(db, -1) });
  assert.equal(syncCards(db, wide(db)), 1);
  assert.equal(syncCards(db, wide(db)), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM custdev_cards').get().n, 1);
});

test('глубже 90 дней не подметаем — иначе доска открылась бы тысячами карточек', () => {
  const db = fresh();
  paidVisit(db, { id: 8, day: dayOffset(db, -200) });
  assert.equal(syncCards(db, { from: dayOffset(db, -365), to: dayOffset(db, 0) }), 0);
});
