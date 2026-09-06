// CATEGORY_DISCOUNT_V1 (2026-09-06) — СКИДКА ГРУППЫ ЭТО ДЕНЬГИ, И СЧИТАЕТ ИХ
// СЕРВЕР.
//
// Владелец: «in the category settings should be selected the discount amount to
// the patient group. which means when patient selected with the category
// discount should be applied».
//
// Ключевое слово — «applied», то есть САМА. Если бы процент подставлял экран и
// присылал готовую сумму, скидка зависела бы от того, какая страница открыта у
// кассира и не устарела ли она; счёт же обязан получиться одинаковым, кто бы
// его ни выставил и из какого окна. Поэтому проверяется не подстановка в форме,
// а ИТОГОВЫЙ СЧЁТ, посчитанный сервером.
//
// Отдельно закреплено правило сложения: скидка категории — это ПОЛ. Пациент
// своей группы не лишается никогда, но ручная скидка кассира может быть больше.
// Ни сложения (двойная скидка за одно и то же), ни замены на меньшую (молча
// отнятые у VIP условия).

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { patientCategoryDiscount, createInvoiceForVisit } from './billing.js';

function seed({ withCategory = true, percent = 10, active = 1 } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,?,?,?,?)')
    .run('reg', 'x', 'Регистратор', 'registrar');
  const cat = db.prepare('INSERT INTO patient_categories (name, discount_percent, active) VALUES (?,?,?)')
    .run('VIP', percent, active);
  db.prepare('INSERT INTO patients (id, mrn, full_name, category_id) VALUES (1, ?, ?, ?)')
    .run('P-1', 'Тестов Тест', withCategory ? cat.lastInsertRowid : null);
  db.prepare("INSERT INTO services (id, name, price, active) VALUES (1, 'Приём', 100000, 1)").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1, 1, '2026-09-06T09:00:00Z', 'scheduled')").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status) VALUES (1,1,1,1,100000,100000,'added')").run();
  return db;
}

const USER = { id: 1, role: 'registrar' };
const invoiceOf = (db) => db.prepare('SELECT subtotal, discount_amount, total_amount FROM invoices WHERE id = (SELECT MAX(id) FROM invoices)').get();

test('процент берётся из справочной строки, на которую ссылается пациент', (t) => {
  const db = seed({ percent: 10 });
  t.after(() => db.close());
  assert.equal(patientCategoryDiscount(db, 1), 10);
  // Переименование категории связь не рвёт — на то она и ссылка, а не текст.
  db.prepare("UPDATE patient_categories SET name = 'VIP-клиент' WHERE name = 'VIP'").run();
  assert.equal(patientCategoryDiscount(db, 1), 10, 'переименование категории отняло скидку');
});

test('счёт выставляется со скидкой группы, хотя её никто не присылал', (t) => {
  const db = seed({ percent: 10 });
  t.after(() => db.close());

  // Ни слова о скидке в запросе — ровно как из мастера визита по умолчанию.
  createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [1] }, USER);

  const inv = invoiceOf(db);
  assert.equal(inv.subtotal, 100000);
  assert.equal(inv.discount_amount, 10000, 'скидка группы не применилась сама — а именно это и просили');
  assert.equal(inv.total_amount, 90000);
});

test('ручная скидка больше — действует она; меньше — действует скидка группы', (t) => {
  const db = seed({ percent: 10 });
  t.after(() => db.close());

  createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [1], discount_amount: 25000 }, USER);
  assert.equal(invoiceOf(db).discount_amount, 25000, 'большая ручная скидка обязана победить');

  // Вторая половина — на СВОЕЙ базе, а не разбором первой: счёт, его строки и
  // услуги визита связаны ключами в три звена, и «почистить и повторить»
  // проверяло бы порядок удаления, а не правило скидки.
  const db2 = seed({ percent: 10 });
  t.after(() => db2.close());
  createInvoiceForVisit(db2, { visit_id: 1, visit_service_ids: [1], discount_amount: 1000 }, USER);
  assert.equal(invoiceOf(db2).discount_amount, 10000,
    'меньшая ручная скидка отняла у пациента условия его группы');
});

test('категория не выбрана или снята с учёта — скидки нет', (t) => {
  const noCat = seed({ withCategory: false });
  assert.equal(patientCategoryDiscount(noCat, 1), 0, 'пациент без категории получил скидку из ничего');
  noCat.close();

  const off = seed({ active: 0 });
  assert.equal(patientCategoryDiscount(off, 1), 0,
    'снятая с учёта категория продолжает давать скидку — выключить её было бы нечем');
  off.close();
});

test('испорченный процент не делает счёт отрицательным', (t) => {
  const db = seed({ percent: 400 });
  t.after(() => db.close());
  assert.equal(patientCategoryDiscount(db, 1), 100, 'процент больше ста обязан быть срезан');

  createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [1] }, USER);
  const inv = invoiceOf(db);
  assert.equal(inv.discount_amount, 100000);
  assert.equal(inv.total_amount, 0, 'счёт ушёл в минус — этого не должно случаться ни при каких данных справочника');
});

test('скидка считается от суммы ЭТОГО счёта, а не от прайса', (t) => {
  const db = seed({ percent: 50 });
  t.after(() => db.close());
  // Две штуки услуги: скидка обязана быть от 200 000, а не от 100 000.
  db.prepare('UPDATE visit_services SET quantity = 2, total = 200000 WHERE id = 1').run();
  createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [1] }, USER);
  const inv = invoiceOf(db);
  assert.equal(inv.subtotal, 200000);
  assert.equal(inv.discount_amount, 100000);
});
