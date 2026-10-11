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
import { createInvoiceForVisit, recordPayment, refundInvoiceLine } from '../../services/rpc/billing.js';   // SERVICES_PACKAGES_V1 (ревью C1)
import { cashierUnbilled, voidInvoice } from '../../services/rpc/cashier.js';
import { today } from '../../services/domain/day.js';
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
  // Ревью C1 (повторная проверка) — процент пакета, замороженный на день
  // обновления, — только там, где скидка группы пациента была больше скидки
  // пакета: у строки 3 (VIP 30 % > 20 %). Строка 1 выставлена со скидкой
  // пакета — её цена и так только пакетная.
  assert.deepEqual(after.map((r) => [r.id, r.package_legacy]), [[1, null], [2, null], [3, 20], [4, null], [5, null], [6, null], [7, null], [8, null]]);
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
// такой строке (package_legacy — процент пакета на день обновления) берёт только скидку пакета, как до 244;
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
    { package_full: 100000, package_price: 70000, package_legacy: 20 });
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
      { package_full: 100000, package_price: 80000, package_legacy: null });
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
  assert.deepEqual({ ...got(1) }, { package_full: null, package_price: null, package_legacy: null }, 'позиция счёта с текстом');
  assert.deepEqual({ ...got(2) }, { package_full: null, package_price: null, package_legacy: null }, 'цена строки — текст');
  assert.deepEqual({ ...got(3) }, { package_full: 50000, package_price: 40000, package_legacy: null }, 'скидка группы — текст: как без группы, только пакет');
});

// SERVICES_PACKAGES_V1 (ревью C1, повторная проверка) — ПРОЦЕНТ ПАКЕТА
// ЗАМОРОЖЕН НА ДЕНЬ ОБНОВЛЕНИЯ. package_legacy хранит процент пакета, каким он
// был при обновлении, и только у строк, чья записанная цена несёт скидку группы
// пациента: невыставленных, где группа больше пакета, и выставленных пациенту
// (счёт без плательщика) со скидкой больше пакетной. Правка процента после
// обновления (и пересохранение окном «Пакет услуг», которое пишет процент
// раскладки — 15 → 15,1), удаление пакета — счёт плательщику, «Ждут счёта» и
// долю врача не двигают. Клиника — сегодняшним днём (как сквозной тест денег),
// счёт до 244 — по правилу до 244 (пациенту — бо́льшая из скидок, плательщику —
// скидка пакета). Сценарии — повторной проверки ревью (zz-s6f-c1-lens).
// before(db) — что поменяли в клинике до обновления (после счёта); qty / price — строка.
function upgraded({ groupPct = 0, pkgPct = 20, billed = null, before = null, qty = 1, price = 100000 } = {}) {
  const db = dbBefore244();
  const day = today(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, service_rate_default) VALUES (?,?,?,?,?,?,?,0)');
  u.run(1, 'doc', 'x', 'doctor', 'Доктор', 1, JSON.stringify([{ service_id: 1, pct: 30 }]));
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '');
  db.prepare("INSERT INTO payers (id, name, kind, active) VALUES (3, 'Страховая', 'insurance', 1)").run();
  let cat = null;
  if (groupPct) { db.prepare("INSERT INTO patient_categories (id, name, discount_percent, active) VALUES (5, 'VIP', ?, 1)").run(groupPct); cat = 5; }
  db.prepare("INSERT INTO patients (id, mrn, full_name, category_id, payer_id) VALUES (1, 'P-1', 'Пациент', ?, 3)").run(cat);
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (1, 'УЗИ', ?, 0)").run(price);
  db.prepare("INSERT INTO service_templates (id, name, service_ids, discount_percent) VALUES (1, 'Осень', '[1]', ?)").run(pkgPct);
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1, 1, ?, 'arrived')").run(day + 'T09:00:00Z');
  const gross = Math.round(price * qty * 100) / 100;
  let itemId = null;
  if (billed) {
    const pct = billed === 'patient' ? Math.max(pkgPct, groupPct) : pkgPct;   // правило счёта до 244
    const disc = Math.round(gross * pct) / 100;
    db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, status, payer_id) VALUES (1, 'INV-1', 1, 1, ?, ?, ?, 'unpaid', ?)")
      .run(gross, disc, Math.round((gross - disc) * 100) / 100, billed === 'payer' ? 3 : null);
    db.prepare("INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total, discount_amount) VALUES (1, 1, 1, 'УЗИ', ?, ?, ?, ?)").run(qty, price, gross, disc);
    itemId = 1;
  }
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, package_id, invoice_item_id) VALUES (1, 1, 1, 1, ?, ?, ?, 'completed', 1, ?)").run(qty, price, gross, itemId);
  if (before) before(db);
  migrate(db);
  const fee = () => Math.round(doctorPaySummary(db, { doctor_id: 1, from: day, to: day }, admin).outpatient.fee);
  const waiting = () => { const r = cashierUnbilled(db, {}, admin).rows.find((x) => x.visit_id === 1); return r ? r.total : null; };
  const bill = (payer) => createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [1], payer_id: payer, discount_amount: 0 }, admin).invoice.total_amount;
  return { db, fee, waiting, bill };
}
const legacyOf = (db) => db.prepare('SELECT package_legacy FROM visit_services WHERE id = 1').get().package_legacy;
const AFTER_UPGRADE = {
  'процент пакета поменяли 20 → 10': (db) => db.prepare("UPDATE service_templates SET discount_percent = 10, discount_value = 10 WHERE id = 1").run(),
  'пакет пересохранили (процент раскладки 20,4)': (db) => db.prepare('UPDATE service_templates SET discount_percent = 20.4 WHERE id = 1').run(),
  'пакет удалили': (db) => db.prepare('DELETE FROM service_templates WHERE id = 1').run(),
};

test('244 (ревью C1, повторно): процент пакета заморожен — только где группа была больше пакета', () => {
  assert.equal(legacyOf(upgraded({ groupPct: 30 }).db), 20, 'невыставленная VIP 30 % > 20 %');
  assert.equal(legacyOf(upgraded({ groupPct: 10 }).db), null, 'группа меньше пакета — цена и так пакетная');
  assert.equal(legacyOf(upgraded().db), null, 'без группы');
  assert.equal(legacyOf(upgraded({ groupPct: 30, billed: 'patient' }).db), 20, 'выставлена VIP-пациенту со скидкой группы');
  assert.equal(legacyOf(upgraded({ groupPct: 30, billed: 'payer' }).db), null, 'выставлена плательщику — скидка пакета');
  assert.equal(legacyOf(upgraded({ groupPct: 10, billed: 'patient' }).db), null, 'выставлена пациенту, пакет больше группы');
  assert.throws(() => upgraded().db.prepare('UPDATE visit_services SET package_legacy = 101 WHERE id = 1').run(), /CHECK/);
});

test('244 (ревью C1, повторно): после обновления процент поменяли, пакет пересохранили или удалили — деньги строки до 244 не двигаются', () => {
  for (const [what, change] of Object.entries(AFTER_UPGRADE)) {
    // VIP: плательщику — 80 000 (пакет на день обновления), пациенту — 70 000 (как назвала смета).
    let c = upgraded({ groupPct: 30 });
    change(c.db);
    assert.equal(c.waiting(), 80000, what + ': «Ждут счёта» VIP');
    assert.equal(c.fee(), 21000, what + ': доля врача до счёта VIP');
    assert.equal(c.bill(3), 80000, what + ': плательщику VIP');
    assert.equal(c.fee(), 24000, what + ': доля врача после счёта плательщику');
    c = upgraded({ groupPct: 30 });
    change(c.db);
    assert.equal(c.bill(null), 70000, what + ': пациенту VIP');
    // Без группы: «Ждут счёта» = счёт пациенту = счёт плательщику = 80 000, доля врача не двигается.
    c = upgraded();
    change(c.db);
    assert.deepEqual([c.waiting(), c.fee()], [80000, 24000], what + ': без группы, до счёта');
    assert.equal(c.bill(3), 80000, what + ': без группы, плательщику');
    assert.equal(c.fee(), 24000, what + ': без группы, доля врача после счёта');
    c = upgraded();
    change(c.db);
    assert.equal(c.bill(null), 80000, what + ': без группы, пациенту');
  }
});

test('244 (ревью C1, повторно): счёт VIP-пациенту до обновления — отмена или возврат, затем счёт плательщику — скидка пакета, как до 244', () => {
  let c = upgraded({ groupPct: 30, billed: 'patient' });
  voidInvoice(c.db, { invoice_id: 1, keep_services: true }, admin);
  assert.equal(c.waiting(), 80000);
  assert.equal(c.bill(3), 80000, 'отмена → плательщику');
  assert.equal(c.fee(), 24000);
  c = upgraded({ groupPct: 30, billed: 'patient' });
  voidInvoice(c.db, { invoice_id: 1, keep_services: true }, admin);
  assert.equal(c.bill(null), 70000, 'отмена → снова пациенту — как назвали');
  c = upgraded({ groupPct: 30, billed: 'patient' });
  recordPayment(c.db, { invoice_id: 1, amount: 70000, method: 'cash' }, admin);
  refundInvoiceLine(c.db, { invoice_item_id: 1, reason: 'отказ' }, admin);
  const r = createInvoiceForVisit(c.db, { visit_id: 1, visit_service_ids: [1], payer_id: 3, discount_amount: 0, rebill_refunded: true }, admin);
  assert.equal(r.invoice.total_amount, 80000, 'возврат → выставить заново плательщику');
});

test('244 (ревью C1, повторно): счёт плательщику до обновления — отмена, затем VIP-пациенту — цена пакета (решение 1)', () => {
  const c = upgraded({ groupPct: 30, billed: 'payer' });
  voidInvoice(c.db, { invoice_id: 1, keep_services: true }, admin);
  assert.equal(c.bill(null), 80000);
});

// SERVICES_PACKAGES_V1 (ревью C1, финальная проверка) — ВЫСТАВЛЕННАЯ ДО 244
// СТРОКА ПОМЕЧАЕТСЯ, ТОЛЬКО ЕСЛИ ЕЁ СКИДКУ МОЖЕТ ОБЪЯСНИТЬ ГРУППА ПАЦИЕНТА
// (группа пациента — действующая или нет — больше пакета на день обновления).
// Без группы скидка выставленной строки — пакетная, какой бы процент пакета ни
// стал к обновлению: отметки нет, цена строки — выставленная, одна для всех.
const lowerPackage = (pct) => (db) => db.prepare('UPDATE service_templates SET discount_percent = ? WHERE id = 1').run(pct);
const voided = (c) => { voidInvoice(c.db, { invoice_id: 1, keep_services: true }, admin); return c; };
const refunded = (c, paid) => {
  recordPayment(c.db, { invoice_id: 1, amount: paid, method: 'cash' }, admin);
  refundInvoiceLine(c.db, { invoice_item_id: 1, reason: 'отказ' }, admin);
  return c;
};
const rebill = (c, payer) => createInvoiceForVisit(c.db, { visit_id: 1, visit_service_ids: [1], payer_id: payer, discount_amount: 0, rebill_refunded: true }, admin).invoice.total_amount;

test('244 (ревью C1, финально): без группы, выставлено по пакету 20 %, пакет до обновления снизили до 10 % или 0 % — отметки нет, 80 000 везде', () => {
  for (const pct of [10, 0]) {
    const opts = { billed: 'patient', before: lowerPackage(pct) };
    assert.equal(legacyOf(upgraded(opts).db), null, 'пакет ' + pct + ' %: отметки нет');
    let c = voided(upgraded(opts));
    assert.deepEqual([c.waiting(), c.fee()], [80000, 24000], pct + ' %: отмена — «Ждут счёта» и доля врача');
    assert.equal(c.bill(3), 80000, pct + ' %: отмена → плательщику');
    assert.equal(c.fee(), 24000);
    assert.equal(voided(upgraded(opts)).bill(null), 80000, pct + ' %: отмена → пациенту');
    assert.equal(rebill(refunded(upgraded(opts), 80000), 3), 80000, pct + ' %: возврат → плательщику');
    assert.equal(rebill(refunded(upgraded(opts), 80000), null), 80000, pct + ' %: возврат → пациенту');
  }
});

test('244 (ревью C1, финально): VIP помечается и тогда, когда группу до обновления выключили или поменяли её процент', () => {
  const off = { groupPct: 30, billed: 'patient', before: (db) => db.prepare('UPDATE patient_categories SET active = 0 WHERE id = 5').run() };
  assert.equal(legacyOf(upgraded(off).db), 20, 'группа выключена');
  assert.equal(voided(upgraded(off)).bill(3), 80000);
  assert.equal(voided(upgraded(off)).bill(null), 70000, 'пациенту — как выставили');
  // Процент группы поменяли 30 → 25 до обновления: счёт был со скидкой группы 30 % — плательщику её не отдаём.
  const changed = { groupPct: 30, billed: 'patient', before: (db) => db.prepare('UPDATE patient_categories SET discount_percent = 25 WHERE id = 5').run() };
  assert.equal(legacyOf(upgraded(changed).db), 20, 'процент группы поменяли');
  assert.equal(voided(upgraded(changed)).bill(3), 80000);
  assert.equal(rebill(refunded(upgraded(changed), 70000), 3), 80000, 'возврат → плательщику');
  assert.equal(rebill(refunded(upgraded(changed), 70000), null), 70000, 'возврат → пациенту — как выставили');
});

test('244 (ревью C1, финально): группа меньше пакета на день счёта, пакет до обновления снизили ниже группы — плательщику процент пакета на день обновления, как до 244; пациенту — как выставили', () => {
  // Пакет 20 % > группы 15 % — счёт по пакету (80 000); пакет снизили до 10 %. Скидку
  // строки объясняет и группа (15 % > 10 %), и прежний пакет — какая была, база уже не
  // знает. Строка помечается: плательщику — 10 % (90 000) — ровно столько, сколько при
  // повторном счёте плательщику выставил бы код до 244 (живой процент пакета); иначе
  // при смене процента группы (тест выше) страховая получала бы скидку VIP.
  const opts = { groupPct: 15, billed: 'patient', before: lowerPackage(10) };
  assert.equal(legacyOf(upgraded(opts).db), 10);
  assert.equal(voided(upgraded(opts)).bill(3), 90000);
  assert.equal(voided(upgraded(opts)).bill(null), 80000);
});

test('244 (ревью C1, финально): количество 3, цена не круглая — отметка и деньги как до 244', () => {
  const opts = { groupPct: 30, billed: 'patient', qty: 3, price: 33333 };   // 99 999; VIP 29 999,70; пакет 19 999,80
  assert.equal(legacyOf(upgraded(opts).db), 20);
  assert.equal(voided(upgraded(opts)).bill(3), 79999.2, 'плательщику — 99 999 − 20 %');
  assert.equal(voided(upgraded(opts)).bill(null), 69999.3, 'пациенту — как выставили');
  const unbilled = { groupPct: 30, qty: 3, price: 33333 };
  assert.equal(legacyOf(upgraded(unbilled).db), 20);
  assert.equal(upgraded(unbilled).bill(3), 79999.2);
  assert.equal(upgraded(unbilled).bill(null), 69999.3);
  const plain = { billed: 'patient', qty: 3, price: 33333, before: lowerPackage(10) };   // без группы
  assert.equal(legacyOf(upgraded(plain).db), null);
  assert.equal(voided(upgraded(plain)).bill(3), 79999.2, 'без группы — как выставили, и плательщику');
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
