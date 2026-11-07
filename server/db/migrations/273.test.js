// DISCOUNT_V2 · CASHIER_DISCOUNT_V1 — миграция 273: переключатель «Скидка уменьшает
// долю врача» у скидки и у группы пациентов; у счёта — выбранная скидка, её причина
// и доля скидки, уменьшающая долю врача. Только добавление: прежние строки — как в 3.21.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { SHIPPED } from '../../services/branch-sync/journal.js';

test('мигр. 273: колонки на месте, у прежних строк — сегодняшнее поведение (уменьшает, доля 1)', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols('patient_discounts').includes('reduces_doctor_share'));
  assert.ok(cols('patient_categories').includes('reduces_doctor_share'));
  for (const c of ['discount_source', 'discount_note', 'doctor_discount_share']) assert.ok(cols('invoices').includes(c), c);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Тест')").run();
  const d = db.prepare("INSERT INTO patient_discounts (name, kind, percent) VALUES ('ЛЕТО', 'promo', 10)").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT reduces_doctor_share r FROM patient_discounts WHERE id = ?').get(d).r, 1);
  const c = db.prepare("INSERT INTO patient_categories (name, discount_percent) VALUES ('VIP', 10)").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT reduces_doctor_share r FROM patient_categories WHERE id = ?').get(c).r, 1);
  const i = db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount) VALUES ('INV-1', 1, 100, 100)").run().lastInsertRowid;
  assert.deepEqual(db.prepare('SELECT discount_source, discount_note, doctor_discount_share FROM invoices WHERE id = ?').get(i),
    { discount_source: null, discount_note: null, doctor_discount_share: 1 });
  db.close();
});

test('мигр. 273: переключатель — 0 или 1; доля — от 0 до 1; причина не длиннее 500 знаков', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Тест')").run();
  assert.throws(() => db.prepare("INSERT INTO patient_discounts (name, kind, reduces_doctor_share) VALUES ('X', 'promo', 2)").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO patient_categories (name, reduces_doctor_share) VALUES ('X', -1)").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, doctor_discount_share) VALUES ('A', 1, 0, 0, 1.5)").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, discount_note) VALUES ('B', 1, 0, 0, ?)").run('я'.repeat(501)), /CHECK/);
  db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, doctor_discount_share, discount_note) VALUES ('C', 1, 0, 0, 0.25, ?)").run('я'.repeat(500));
  db.close();
});

test('мигр. 273: колонки счёта — свои у здания, в соседнее не едут (как manual_discount, мигр. 219)', () => {
  for (const c of ['discount_source', 'discount_note', 'doctor_discount_share']) assert.ok(!SHIPPED.invoices.includes(c), c);
});
