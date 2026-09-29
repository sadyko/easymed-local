// SUPPLIERS_VAT_V1 (ревью F3) — НДС ТОВАРА В ОТЧЁТЕ — СТАВКА, ЗАПИСАННАЯ У
// СТРОКИ, А НЕ СЕГОДНЯШНЯЯ СТАВКА КАРТОЧКИ.
//
// Первая версия ветки читала products.vat_rate в момент отчёта. После
// миграции 222 ставка у всех товаров пустая, и первая же настройка ставок
// владельцем переписала бы «Налог», «После налога» и «в т.ч. НДС (товары)»
// у КАЖДОГО прошлого месяца. Проба ревью: оплаченная продажа на 112 000
// сорок дней назад — «Налог» 0; ставку 12 % поставили в карточке — 12 000;
// импорт строки прихода «без НДС» — снова 0 (импорт писал ставку продажи из
// колонки прихода).
//
// Правило: отчёт за месяц читается одинаково до и после обновления и до и
// после любой правки ставки товара. Ставка записывается У СТРОКИ в момент
// выдачи (visit_services / admission_services.goods_vat_rate) и переходит в
// строку счёта при выставлении (invoice_items.goods_vat_rate); строки,
// выданные до обновления, ставки не имеют и считаются как в 3.12.1 — налог 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const FROM = '2020-01-01';
const TO = '2099-12-31';
const run = (db, kind) => getRpc('run_report')(db, { kind, from: FROM, to: TO }, ADMIN);
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const call = (name, db, args) => getRpc(name)(db, args, ADMIN);
const ago = (days) => new Date(Date.now() - days * 86400e3).toISOString().replace(/\.\d+Z$/, 'Z');

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES
    (1,'adm','x','admin','Админ',1)`).run();
  // Товар заведён до обновления: ставки нет (NULL — как у всех после миграции 222).
  db.prepare("INSERT INTO products (id, name, sale_price, on_hand, procurement_category, base_unit) VALUES (1, 'Бинт', 56000, 100, 'consumables', 'шт')").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'A-1', 'Азизов А.')").run();
  return db;
}

/** Строка, выданная и оплаченная `days` дней назад, как её оставила 3.12.1. */
function oldPaidSale(db, days, invoiceNo) {
  const at = ago(days);
  const v = db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (1, 1, ?, 'arrived')").run(at).lastInsertRowid;
  const vs = db.prepare(`INSERT INTO visit_services (visit_id, clinic_item_id, doctor_id, quantity, unit_price, total, status, created_at)
                         VALUES (?, 1, 1, 2, 56000, 112000, 'added', ?)`).run(v, at).lastInsertRowid;
  const inv = db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at, paid_at)
                          VALUES (?, ?, 1, 112000, 0, 112000, 112000, 'paid', ?, ?)`).run(invoiceNo, v, at, at).lastInsertRowid;
  const ii = db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total, created_at) VALUES (?, NULL, 'Бинт', 2, 56000, 112000, ?)").run(inv, at).lastInsertRowid;
  db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(ii, vs);
  db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at, cashier_id) VALUES (?, 112000, 'cash', ?, 1)").run(inv, at);
  return { v, vs, inv };
}

/** Выдача и счёт настоящими вызовами (сегодня). */
function newSale(db) {
  const v = Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (1, 1, ?, 'arrived')").run(ago(0)).lastInsertRowid);
  const d = call('dispense_item', db, { product_id: 1, quantity: 2, visit_id: v, doctor_id: 1 });
  const inv = call('create_invoice_for_visit', db, { visit_id: v, visit_service_ids: [d.visit_service_id] });
  return { v, vs: d.visit_service_id, invoiceNo: inv.invoice_number || (db.prepare('SELECT invoice_number FROM invoices WHERE id = ?').get(inv.invoice_id || inv.id) || {}).invoice_number };
}

const revenueLine = (db, invoiceNo) => objects(run(db, 'total_revenue')).find((o) => o['№ счёта'] === invoiceNo);
const money = (o) => o && [o['Налог %'], o['Налог'], o['в т.ч. НДС (товары)']];

test('ревью F3: прошлый месяц читается одинаково — до ставки, после ставки в карточке, после импорта прихода «без НДС»', () => {
  const db = seed();
  try {
    oldPaidSale(db, 40, 'INV-OLD');
    const before = money(revenueLine(db, 'INV-OLD'));
    assert.deepEqual(before, [0, 0, null], 'как в 3.12.1: у товара налога нет');

    // Владелец ставит ставку в карточке — прошлое не меняется.
    call('product_save', db, { id: 1, name: 'Бинт', procurement_category: 'consumables', vat_rate: 12 });
    assert.deepEqual(money(revenueLine(db, 'INV-OLD')), before, 'ставка из карточки переписала прошлый месяц');

    // Импорт прихода «без НДС»: ставка ПРОДАЖИ товара не трогается, прошлое — тоже.
    const r = call('import_products_excel', db, { rows: [{ name: 'Бинт', qty: 10, unit_cost: 40000, receipt_vat_rate: 'без НДС' }] });
    assert.equal(r.received, 1);
    assert.equal(db.prepare('SELECT vat_rate FROM products WHERE id = 1').get().vat_rate, 12, 'строка прихода сбросила ставку продажи товара');
    const mv = db.prepare("SELECT vat_rate, vat_amount FROM stock_movements WHERE reference_type = 'import'").get();
    assert.deepEqual({ ...mv }, { vat_rate: null, vat_amount: 0 }, 'приход — «без НДС» (записан), а не «не указан»');
    assert.deepEqual(money(revenueLine(db, 'INV-OLD')), before);
  } finally { db.close(); }
});

test('ревью F3: новая выдача берёт ставку на момент выдачи; правка ставки потом её не меняет; выданное до ставки — налог 0 и в новом счёте', () => {
  const db = seed();
  try {
    // Выдано до того, как поставили ставку, а счёт — после: как в 3.12.1.
    const v0 = Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (1, 1, ?, 'arrived')").run(ago(1)).lastInsertRowid);
    const early = call('dispense_item', db, { product_id: 1, quantity: 2, visit_id: v0, doctor_id: 1 });
    call('product_save', db, { id: 1, name: 'Бинт', procurement_category: 'consumables', vat_rate: 12 });
    const inv0 = call('create_invoice_for_visit', db, { visit_id: v0, visit_service_ids: [early.visit_service_id] });
    const no0 = db.prepare('SELECT i.invoice_number FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id JOIN visit_services vs ON vs.invoice_item_id = ii.id WHERE vs.id = ?').get(early.visit_service_id).invoice_number;
    assert.ok(inv0);
    assert.deepEqual(money(revenueLine(db, no0)), [0, 0, null], 'выдано до ставки — налог 0');

    // Выдано при 12 %: 112 000 → налог 13 440 (внутри цены, × 12 / 100, как у услуги).
    const s = newSale(db);
    const no1 = db.prepare('SELECT i.invoice_number FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id JOIN visit_services vs ON vs.invoice_item_id = ii.id WHERE vs.id = ?').get(s.vs).invoice_number;
    assert.deepEqual(money(revenueLine(db, no1)), [12, 13440, 13440]);
    assert.equal(db.prepare('SELECT goods_vat_rate FROM visit_services WHERE id = ?').get(s.vs).goods_vat_rate, 12);

    // Ставку сменили на 0 % — записанная продажа остаётся с 12 %.
    call('product_save', db, { id: 1, name: 'Бинт', procurement_category: 'consumables', vat_rate: 0 });
    assert.deepEqual(money(revenueLine(db, no1)), [12, 13440, 13440]);
    assert.deepEqual(money(revenueLine(db, no0)), [0, 0, null]);
  } finally { db.close(); }
});

test('ревью F3: строка стационара — ставка на момент выдачи; счёт, выставленный с уже привязанной строкой, тоже её получает', () => {
  const db = seed();
  try {
    db.prepare('UPDATE products SET vat_rate = 12 WHERE id = 1').run();
    const now = ago(0);
    const adm = db.prepare("INSERT INTO admissions (patient_id, doctor_id, status, admission_no, admitted_at) VALUES (1, 1, 'active', 'A-1', ?)").run(now).lastInsertRowid;
    const ainv = db.prepare(`INSERT INTO invoices (invoice_number, patient_id, admission_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                             VALUES ('ADM-1', 1, ?, 112000, 0, 112000, 0, 'unpaid', ?)`).run(adm, now).lastInsertRowid;
    const aii = db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, NULL, 'Бинт', 2, 56000, 112000)").run(ainv).lastInsertRowid;
    db.prepare(`INSERT INTO admission_services (admission_id, clinic_item_id, doctor_id, quantity, unit_price, total, status, billable, invoice_item_id, performed_at)
                VALUES (?, 1, 1, 2, 56000, 112000, 'added', 1, ?, ?)`).run(adm, aii, now);
    db.prepare('UPDATE products SET vat_rate = NULL WHERE id = 1').run();
    assert.deepEqual(money(revenueLine(db, 'ADM-1')), [12, 13440, 13440]);
    assert.equal(db.prepare('SELECT goods_vat_rate FROM invoice_items WHERE id = ?').get(aii).goods_vat_rate, 12);
  } finally { db.close(); }
});

test('ревью F3: импорт — «НДС продажи» и «НДС прихода» раздельно; новый товар берёт ставку продажи, а без неё — ставку прихода', () => {
  const db = seed();
  try {
    db.prepare('UPDATE products SET vat_rate = 12 WHERE id = 1').run();
    // Существующий товар: «НДС продажи» — явная правка карточки; «НДС прихода» — только приход.
    call('import_products_excel', db, { rows: [{ name: 'Бинт', qty: 5, unit_cost: 1000, receipt_vat_rate: '0%' }] });
    assert.equal(db.prepare('SELECT vat_rate FROM products WHERE id = 1').get().vat_rate, 12);
    call('import_products_excel', db, { rows: [{ name: 'Бинт', sale_vat_rate: 'без НДС' }] });
    assert.equal(db.prepare('SELECT vat_rate FROM products WHERE id = 1').get().vat_rate, null, 'явная колонка «НДС продажи» правит карточку');
    // Новый товар: без «НДС продажи» — ставка прихода; с ней — она.
    call('import_products_excel', db, { rows: [
      { name: 'Вата', category: 'Расходники', qty: 3, unit_cost: 500, receipt_vat_rate: '12%' },
      { name: 'Маска', category: 'Расходники', qty: 3, unit_cost: 500, receipt_vat_rate: '12%', sale_vat_rate: '0%' },
      { name: 'Шприц', category: 'Расходники' },
    ] });
    const rate = (n) => db.prepare('SELECT vat_rate FROM products WHERE name = ?').get(n).vat_rate;
    assert.equal(rate('Вата'), 12);
    assert.equal(rate('Маска'), 0);
    assert.equal(rate('Шприц'), null);
    // Прежний единый ключ «НДС» неоднозначен — отказ словами, а не догадка.
    assert.throws(() => call('import_products_excel', db, { rows: [{ name: 'Бинт', vat_rate: '12%' }] }),
      (e) => e.status === 400 && /«НДС продажи»/.test(e.message) && /«НДС прихода»/.test(e.message));
  } finally { db.close(); }
});
