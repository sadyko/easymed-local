// DISCOUNT_RATES_V1 — миграция 274: ставки скидки по группам, категориям и отдельным
// услугам у скидки группы пациентов и у скидок клиники; у строки счёта — процент,
// которым её посчитала скидка со ставками, и доля этой скидки, уменьшающая долю врача.
// Только добавление: прежние группы, скидки и строки — как в 3.21 / 3.22 без ставок.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { SHIPPED } from '../../services/branch-sync/journal.js';

test('мигр. 274: колонки на месте; у прежних строк ставок нет (пустой объект / NULL)', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols('patient_categories').includes('discount_rates'));
  assert.ok(cols('patient_discounts').includes('discount_rates'));
  assert.ok(cols('invoice_items').includes('discount_rate'));
  assert.ok(cols('invoice_items').includes('discount_doctor_share'));
  const c = db.prepare("INSERT INTO patient_categories (name, discount_percent) VALUES ('VIP', 10)").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT discount_rates r FROM patient_categories WHERE id = ?').get(c).r, '{}');
  const d = db.prepare("INSERT INTO patient_discounts (name, kind, percent) VALUES ('ЛЕТО', 'promo', 10)").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT discount_rates r FROM patient_discounts WHERE id = ?').get(d).r, '{}');
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Тест')").run();
  const i = db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount) VALUES ('INV-1', 1, 100, 100)").run().lastInsertRowid;
  const it = db.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (?, 'x', 1, 100, 100)").run(i).lastInsertRowid;
  assert.deepEqual(db.prepare('SELECT discount_rate, discount_doctor_share FROM invoice_items WHERE id = ?').get(it),
    { discount_rate: null, discount_doctor_share: null });
  db.close();
});

test('мигр. 274: ставки — JSON; процент строки — 0..100; доля — 0..1', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.throws(() => db.prepare("INSERT INTO patient_categories (name, discount_rates) VALUES ('X', 'не json')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO patient_discounts (name, kind, discount_rates) VALUES ('X', 'promo', '{')").run(), /CHECK/);
  db.prepare(`INSERT INTO patient_categories (name, discount_rates) VALUES ('Сотрудники', '{"g":{"consultation":100}}')`).run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Тест')").run();
  const i = db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount) VALUES ('INV-1', 1, 100, 100)").run().lastInsertRowid;
  const ins = (rate, share) => db.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total, discount_rate, discount_doctor_share) VALUES (?, 'x', 1, 100, 100, ?, ?)").run(i, rate, share);
  assert.throws(() => ins(101, null), /CHECK/);
  assert.throws(() => ins(-1, null), /CHECK/);
  assert.throws(() => ins(20, 1.5), /CHECK/);
  ins(0, 0); ins(100, 1); ins(12.5, null);
  db.close();
});

test('мигр. 274: колонки строки счёта — свои у здания, в соседнее не едут (как мигр. 273)', () => {
  for (const c of ['discount_rate', 'discount_doctor_share']) assert.ok(!SHIPPED.invoice_items.includes(c), c);
});
