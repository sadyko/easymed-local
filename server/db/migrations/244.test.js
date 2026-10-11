// SERVICES_PACKAGES_V1 (мигр. 244) — пакеты услуг: только ADD COLUMN; бэкфилл
// только новых колонок. Пакетом становится строка со скидкой или сроком; строки
// визита из пакета со скидкой получают записанную цену: выставленные — из
// позиции счёта, невыставленные — по правилу, которое им назвали при записи.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { createInvoiceForVisit } from '../../services/rpc/billing.js';   // SERVICES_PACKAGES_V1 (ревью C1)
import { doctorPaySummary } from '../../services/rpc/reports.js';
import { insertVisitLine } from '../../test-helpers/package-line.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dbBefore244() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig244-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 244)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

function seed(db) {
  db.prepare("INSERT INTO patient_categories (id, name, discount_percent, active) VALUES (5, 'VIP', 30, 1), (6, 'Старая', 50, 0)").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name, category_id) VALUES (1, 'P-1', 'Обычный', NULL), (2, 'P-2', 'VIP', 5), (3, 'P-3', 'Старая группа', 6)").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'УЗИ', 100000), (2, 'Анализ', 50000)").run();
  const t = db.prepare('INSERT INTO service_templates (id, name, service_ids, discount_percent, valid_from, valid_until) VALUES (?,?,?,?,?,?)');
  t.run(1, 'Осень', '[1,2]', 20, '2026-09-01', '2026-12-31');   // пакет со скидкой и сроком
  t.run(2, 'Смета терапевта', '[1,2]', 0, null, null);          // шаблон сметы
  t.run(3, 'Акция без скидки', '[1]', 0, null, '2026-12-31');    // в «Пакетах» дали только срок
  t.run(4, 'Скидка без срока', '[2]', 12.5, null, null);
  const v = db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?, ?, '2026-10-01T09:00:00Z', 'arrived')");
  v.run(1, 1); v.run(2, 2); v.run(3, 3);
  db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount) VALUES (1, 'INV-1', 1, 1, 100000, 20000, 80000)").run();
  db.prepare("INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total, discount_amount) VALUES (1, 1, 1, 'УЗИ', 1, 100000, 100000, 20000)").run();
  const vs = db.prepare('INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status, package_id, invoice_item_id) VALUES (?,?,?,?,?,?,?,?,?)');
  vs.run(1, 1, 1, 1, 100000, 100000, 'completed', 1, 1);     // выставлена со скидкой пакета
  vs.run(2, 1, 2, 1, 50000, 50000, 'added', 1, null);        // не выставлена, обычный пациент: 20 %
  vs.run(3, 2, 2, 2, 50000, 100000, 'added', 1, null);       // VIP 30 % > пакета 20 %: 30 %
  vs.run(4, 3, 2, 1, 50000, 50000, 'added', 1, null);        // группа выключена: 20 %
  vs.run(5, 1, 1, 1, 100000, 100000, 'added', 2, null);      // шаблон сметы — не пакет
  vs.run(6, 1, 1, 1, 100000, 100000, 'added', 3, null);      // пакет без скидки — обычная строка
  vs.run(7, 1, 2, 1, 50000, 50000, 'added', 4, null);        // 12,5 %
  vs.run(8, 1, 2, 1, 50000, 50000, 'added', null, null);     // не из пакета
}

test('244: пакет — строка со скидкой или сроком; скидка переезжает в discount_value; показ выключен; прежнее не тронуто', () => {
  const db = dbBefore244();
  seed(db);
  const before = db.prepare('SELECT * FROM service_templates ORDER BY id').all();
  migrate(db);
  const after = db.prepare('SELECT * FROM service_templates ORDER BY id').all();
  assert.equal(after.length, before.length);
  after.forEach((row, i) => { for (const [k, v] of Object.entries(before[i])) assert.equal(row[k], v, 'прежнее ' + k); });
  assert.deepEqual(after.map((r) => [r.id, r.is_package, r.discount_mode, r.discount_value, r.show_public, r.name_uz, r.name_en]), [
    [1, 1, 'percent', 20, 0, null, null],
    [2, 0, 'percent', 0, 0, null, null],
    [3, 1, 'percent', 0, 0, null, null],
    [4, 1, 'percent', 12.5, 0, null, null],
  ]);
});

test('244: строки визита — выставленная из позиции счёта, невыставленные по названному правилу, остальные пусты; прежнее не тронуто', () => {
  const db = dbBefore244();
  seed(db);
  const before = db.prepare('SELECT * FROM visit_services ORDER BY id').all();
  migrate(db);
  const after = db.prepare('SELECT * FROM visit_services ORDER BY id').all();
  assert.equal(after.length, before.length);
  after.forEach((row, i) => { for (const [k, v] of Object.entries(before[i])) assert.equal(row[k], v, 'прежнее ' + k + ' строки ' + row.id); });
  assert.deepEqual(after.map((r) => [r.id, r.package_full, r.package_price]), [
    [1, 100000, 80000],     // как выставлено: 100 000 − 20 000
    [2, 50000, 40000],      // пакет 20 %
    [3, 50000, 35000],      // группа 30 % больше пакета — так считала смета
    [4, 50000, 40000],      // выключенная группа не в счёт
    [5, null, null],        // шаблон сметы
    [6, null, null],        // пакет без скидки
    [7, 50000, 43750],      // 12,5 %
    [8, null, null],
  ]);
  // Ревью C1 — отметка «цена по правилу до 244» — только у невыставленных строк бэкфилла.
  assert.deepEqual(after.map((r) => [r.id, r.package_legacy]), [[1, 0], [2, 1], [3, 1], [4, 1], [5, 0], [6, 0], [7, 1], [8, 0]]);
});

// SERVICES_PACKAGES_V1 (сборщик А) — выставленные деньги бэкфилл не трогает:
// счета и позиции счёта — те же; записанная цена выставленной строки пакета —
// ровно её позиция счёта (повторное выставление возвращённой строки даст то же).
test('244: счета и позиции счёта не тронуты; цена выставленной строки пакета = её позиция счёта', () => {
  const db = dbBefore244();
  seed(db);
  const money = () => [db.prepare('SELECT * FROM invoices ORDER BY id').all(), db.prepare('SELECT * FROM invoice_items ORDER BY id').all()];
  const before = money();
  migrate(db);
  assert.deepEqual(money(), before);
  const billed = db.prepare(`SELECT vs.package_full, vs.package_price, vs.quantity, ii.unit_price, ii.total, ii.discount_amount
                               FROM visit_services vs JOIN invoice_items ii ON ii.id = vs.invoice_item_id
                              WHERE vs.package_full IS NOT NULL`).all();
  assert.equal(billed.length, 1);
  for (const x of billed) {
    assert.equal(x.package_full, x.unit_price);
    assert.equal(Math.round(x.package_price * x.quantity * 100) / 100, x.total - x.discount_amount);
  }
});

// SERVICES_PACKAGES_V1 (ревью шага 6, C1) — НЕВЫСТАВЛЕННАЯ СТРОКА ДО 244 И
// ПЛАТЕЛЬЩИК. Её цена «по названному правилу» — бо́льшая из скидки пакета и
// группы пациента: так её назвала смета ПАЦИЕНТУ. Плательщику (страховая,
// организация) скидка группы пациента не положена (B5) — счёт плательщику по
// такой строке (package_legacy = 1) берёт только скидку пакета, как до 244;
// пациенту — как назвала смета. Доля врача — от выставленного.
const admin = { id: 9, role: 'admin' };
function vipLine({ groupPct = 30, pkgPct = 20 } = {}) {
  const db = dbBefore244();
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, service_rate_default) VALUES (?,?,?,?,?,?,?,0)');
  u.run(1, 'doc', 'x', 'doctor', 'Доктор', 1, JSON.stringify([{ service_id: 1, pct: 30 }]));
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '');
  db.prepare("INSERT INTO payers (id, name, kind, active) VALUES (3, 'Страховая', 'insurance', 1)").run();
  db.prepare("INSERT INTO patient_categories (id, name, discount_percent, active) VALUES (5, 'VIP', ?, 1)").run(groupPct);
  db.prepare("INSERT INTO patients (id, mrn, full_name, category_id) VALUES (1, 'P-1', 'VIP', 5)").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (1, 'УЗИ', 100000, 0)").run();
  db.prepare("INSERT INTO service_templates (id, name, service_ids, discount_percent) VALUES (1, 'Осень', '[1]', ?)").run(pkgPct);
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1, 1, '2026-10-01T09:00:00Z', 'arrived')").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, package_id) VALUES (1, 1, 1, 1, 1, 100000, 100000, 'completed', 1)").run();
  migrate(db);
  return db;
}
const fee = (db) => Math.round(doctorPaySummary(db, { doctor_id: 1, from: '2026-10-01', to: '2026-10-01' }, admin).outpatient.fee);

test('244 (ревью C1): строка до 244, не выставленная: плательщику — только скидка пакета, как до 244; пациенту — как назвала смета', () => {
  let db = vipLine();
  assert.deepEqual({ ...db.prepare('SELECT package_full, package_price, package_legacy FROM visit_services WHERE id = 1').get() },
    { package_full: 100000, package_price: 70000, package_legacy: 1 });
  assert.equal(fee(db), 21000, 'до счёта — как до 244: от бо́льшей из скидок');
  let r = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [1], payer_id: 3, discount_amount: 0 }, admin);
  assert.deepEqual([r.invoice.total_amount, r.items[0].discount_amount], [80000, 20000], 'плательщику скидки группы пациента нет (B5)');
  assert.equal(fee(db), 24000, 'доля врача — от выставленного плательщику');
  db = vipLine();
  r = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [1] }, admin);
  assert.equal(r.invoice.total_amount, 70000, 'пациенту — как назвала смета до обновления');
  assert.equal(fee(db), 21000);
  db = vipLine({ groupPct: 10 });
  r = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [1], payer_id: 3 }, admin);
  assert.equal(r.invoice.total_amount, 80000, 'группа меньше пакета — та же скидка пакета');
});

test('244 (ревью C1): строка, записанная после 244, — цена пакета окончательная: плательщику и пациенту одна', () => {
  for (const payer of [3, null]) {
    const db = vipLine();
    const id = insertVisitLine(db, { visit_id: 1, service_id: 1, doctor_id: 1, quantity: 1, unit_price: 100000, total: 100000, status: 'completed', package_id: 1 });
    assert.deepEqual({ ...db.prepare('SELECT package_full, package_price, package_legacy FROM visit_services WHERE id = ?').get(id) },
      { package_full: 100000, package_price: 80000, package_legacy: 0 });
    const r = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [id], payer_id: payer }, admin);
    assert.equal(r.invoice.total_amount, 80000, 'плательщик ' + payer);
  }
});

test('244 (ревью C1): бэкфилл берёт только числа — текст в цене строки, позиции счёта или скидке группы строку не помечает', () => {
  const db = dbBefore244();
  seed(db);
  db.prepare("UPDATE visit_services SET unit_price = 'н/д' WHERE id = 2").run();
  db.prepare("UPDATE invoice_items SET discount_amount = 'много' WHERE id = 1").run();
  db.prepare("UPDATE patient_categories SET discount_percent = 'VIP' WHERE id = 5").run();
  migrate(db);
  const got = (id) => db.prepare('SELECT package_full, package_price, package_legacy FROM visit_services WHERE id = ?').get(id);
  assert.deepEqual({ ...got(1) }, { package_full: null, package_price: null, package_legacy: 0 }, 'позиция счёта с текстом');
  assert.deepEqual({ ...got(2) }, { package_full: null, package_price: null, package_legacy: 0 }, 'цена строки — текст');
  assert.deepEqual({ ...got(3) }, { package_full: 50000, package_price: 40000, package_legacy: 1 }, 'скидка группы — текст: как без группы, только пакет');
});

test('244: CHECK — запасной замок: отметки 0/1, способ скидки, процент до 100, цена в пакете не выше цены услуги', () => {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'УЗИ', 100000)").run();
  const id = db.prepare("INSERT INTO service_templates (name, service_ids) VALUES ('П', '[1]')").run().lastInsertRowid;
  const set = (sql, ...a) => db.prepare(`UPDATE service_templates SET ${sql} WHERE id = ?`).run(...a, id);
  assert.throws(() => set('is_package = ?', 2), /CHECK/);
  assert.throws(() => set('show_public = ?', 5), /CHECK/);
  assert.throws(() => set('discount_mode = ?', 'gift'), /CHECK/);
  assert.throws(() => set('discount_value = ?', -1), /CHECK/);
  assert.throws(() => set('discount_value = ?', 101), /CHECK/, 'процент больше 100');
  set("discount_mode = 'price', discount_value = ?", 250000);   // цена пакета — любая неотрицательная сумма
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'P-1', 'П')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (1, 1, '2026-10-01T09:00:00Z')").run();
  const vs = db.prepare('INSERT INTO visit_services (visit_id, service_id, package_full, package_price) VALUES (1, 1, ?, ?)');
  assert.throws(() => vs.run(100000, 120000), /CHECK/, 'цена в пакете выше цены услуги');
  assert.throws(() => vs.run(null, 50000), /CHECK/, 'цена в пакете без цены услуги');
  assert.throws(() => vs.run(-1, null), /CHECK/);
  vs.run(100000, 80000);
  vs.run(null, null);
});
