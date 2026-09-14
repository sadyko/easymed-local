// VISIT_TIER_PRICING_V1 — service_price_quote over real rows: which earlier
// visits count, the window, and what the cashier does with the recorded tier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { servicePriceQuote } from './service-price-quote.js';
import { serviceSave } from './service-save.js';
import { createInvoiceForVisit } from './billing.js';
import { getRpc } from './index.js';

const admin = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
const lab = { id: 3, role: 'lab' };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin'); ins.run(2, 'reg', 'x', 'registrar'); ins.run(3, 'lab', 'x', 'lab');
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Иванов Иван'), (2, 'Петров Пётр')").run();
  return db;
}
// A visit N local days before today, with one line of `serviceId` at `tier`.
function pastVisit(db, { patientId = 1, daysAgo, serviceId, tier = null, status = 'arrived', lineStatus = 'added' }) {
  const day = db.prepare("SELECT datetime('now', 'localtime', ?) || 'Z' AS d").get(`-${daysAgo} days`).d;
  // stored as UTC: convert the local wall time back
  const utc = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?, 'utc') AS u").get(day.replace('Z', '')).u;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, ?)").run(patientId, utc, status).lastInsertRowid;
  db.prepare("INSERT INTO visit_services (visit_id, service_id, unit_price, total, status, price_tier) VALUES (?, ?, 0, 0, ?, ?)")
    .run(vid, serviceId, lineStatus, tier);
  return vid;
}
const tiered = (db, over = {}) => serviceSave(db, {
  name: 'Приём невролога', type: 'consultation', price: 200000, requires_doctor: false, performers: [],
  price_secondary: 60000, secondary_days_from: 1, secondary_days_to: 6, price_repeat: 0, ...over,
}, admin).id;

test('service_save stores the four tier fields and refuses a window without a price', () => {
  const db = fresh();
  const id = tiered(db);
  const row = db.prepare('SELECT price, price_secondary, secondary_days_from, secondary_days_to, price_repeat FROM services WHERE id = ?').get(id);
  assert.deepEqual(row, { price: 200000, price_secondary: 60000, secondary_days_from: 1, secondary_days_to: 6, price_repeat: 0 });
  // Clearing: empty strings mean null, never 0.
  serviceSave(db, { id, name: 'Приём невролога', type: 'consultation', price: 200000, performers: [], price_secondary: '', secondary_days_from: '', secondary_days_to: '', price_repeat: '' }, admin);
  const cleared = db.prepare('SELECT price_secondary, secondary_days_from, secondary_days_to, price_repeat FROM services WHERE id = ?').get(id);
  assert.deepEqual(cleared, { price_secondary: null, secondary_days_from: null, secondary_days_to: null, price_repeat: null });
  assert.throws(() => tiered(db, { price_secondary: null, price_repeat: null, secondary_days_from: 1, secondary_days_to: 6 }), /цену второго визита/);
  assert.throws(() => tiered(db, { secondary_days_from: 6, secondary_days_to: 1 }), /не может быть раньше/);
  assert.throws(() => tiered(db, { price_secondary: -1 }), /неотрицательное/);
  assert.throws(() => tiered(db, { secondary_days_to: 2.5 }), /целое число дней/);
});

test('quote: first visit → primary; 3 days later → secondary; then repeat; 7 days after the last → primary again', () => {
  const db = fresh();
  const id = tiered(db);
  let q = servicePriceQuote(db, { patient_id: 1, service_ids: [id] }, registrar).quotes[id];
  assert.equal(q.tier, 'primary'); assert.equal(q.price, 200000); assert.equal(q.reason, 'first');

  pastVisit(db, { daysAgo: 3, serviceId: id, tier: 'primary' });
  q = servicePriceQuote(db, { patient_id: 1, service_ids: [id] }, registrar).quotes[id];
  assert.equal(q.tier, 'secondary'); assert.equal(q.price, 60000); assert.equal(q.days_since, 3);
  assert.ok(q.prev_day, 'the day the window counts from is reported');

  pastVisit(db, { daysAgo: 1, serviceId: id, tier: 'secondary' });
  q = servicePriceQuote(db, { patient_id: 1, service_ids: [id] }, registrar).quotes[id];
  assert.equal(q.tier, 'repeat'); assert.equal(q.price, 0);

  const db2 = fresh();
  const id2 = tiered(db2);
  pastVisit(db2, { daysAgo: 7, serviceId: id2, tier: 'secondary' });
  q = servicePriceQuote(db2, { patient_id: 1, service_ids: [id2] }, registrar).quotes[id2];
  assert.equal(q.tier, 'primary'); assert.equal(q.reason, 'window_passed');
});

test('quote: another patient, a cancelled visit, a cancelled line and the visit being edited do not count', () => {
  const db = fresh();
  const id = tiered(db);
  pastVisit(db, { patientId: 2, daysAgo: 2, serviceId: id, tier: 'primary' });
  pastVisit(db, { daysAgo: 2, serviceId: id, tier: 'primary', status: 'cancelled' });
  pastVisit(db, { daysAgo: 2, serviceId: id, tier: 'primary', lineStatus: 'cancelled' });
  const editing = pastVisit(db, { daysAgo: 2, serviceId: id, tier: 'primary' });
  assert.equal(servicePriceQuote(db, { patient_id: 1, service_ids: [id], visit_id: editing }, registrar).quotes[id].tier, 'primary');
  assert.equal(servicePriceQuote(db, { patient_id: 1, service_ids: [id] }, registrar).quotes[id].tier, 'secondary', 'without the exclusion that visit is a real first visit');
});

test('quote: a service without tiers answers primary with no lookup; unknown ids are skipped; access is staff-only', () => {
  const db = fresh();
  const plain = serviceSave(db, { name: 'УЗИ', type: 'imaging', price: 90000, performers: [] }, admin).id;
  pastVisit(db, { daysAgo: 2, serviceId: plain, tier: 'primary' });
  const r = servicePriceQuote(db, { patient_id: 1, service_ids: [plain, 9999] }, registrar);
  assert.deepEqual(Object.keys(r.quotes), [String(plain)]);
  assert.equal(r.quotes[plain].tier, 'primary'); assert.equal(r.quotes[plain].reason, 'no_tiers');
  assert.throws(() => servicePriceQuote(db, { patient_id: 1, service_ids: [plain] }, lab), (e) => e.status === 403);
  assert.throws(() => servicePriceQuote(db, { service_ids: [plain] }, registrar), (e) => e.status === 400);
  assert.equal(typeof getRpc('service_price_quote'), 'function');
});

test('the cashier honours the recorded tier: a secondary line is invoiced at 60 000, not the catalog 200 000', () => {
  const db = fresh();
  const id = tiered(db);
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run().lastInsertRowid;
  const vs1 = db.prepare("INSERT INTO visit_services (visit_id, service_id, unit_price, total, status, price_tier) VALUES (?, ?, 60000, 60000, 'added', 'secondary')").run(vid, id).lastInsertRowid;
  const vs2 = db.prepare("INSERT INTO visit_services (visit_id, service_id, unit_price, total, status, price_tier) VALUES (?, ?, 200000, 200000, 'added', NULL)").run(vid, id).lastInsertRowid;
  const inv = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, vs2] }, admin);
  assert.deepEqual(inv.items.map((i) => i.unit_price), [60000, 200000]);
  assert.equal(inv.invoice.subtotal, 260000);
});
