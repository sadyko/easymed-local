// SUPPLIERS_VAT_V1 (2026-09-28) — поставщики ↔ товары, типы товаров, НДС товара
// и прихода, срок годности в импорте Excel (docs/plans/2026-09-28-suppliers-vat.md).
//
// Всё — через настоящие RPC на базе после всех миграций:
//   product_save / supplier_save — карточки со связями одной транзакцией;
//   receive_stock_lines          — цена без НДС, НДС строки, себестоимость с НДС,
//                                  связь с поставщиком помнит цену и ставку;
//   import_products_excel        — тип товара, НДС, цена продажи, партия и срок
//                                  ДД.ММ.ГГГГ, всё или ничего.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { CATEGORY_REQUIRED } from './catalog-goods.js';
import { GOODS_CATEGORY_LIST_RU } from '../../../public/js/shared/goods-catalog.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const INV = { id: 2, role: 'inventory', extra_roles: [] };
const DOC = { id: 3, role: 'doctor', extra_roles: [] };
const call = (name, db, args, user = INV) => getRpc(name)(db, args, user);

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, 'x', ?, ?)");
  u.run(1, 'adm', 'admin', 'Админ'); u.run(2, 'inv', 'inventory', 'Кладовщик'); u.run(3, 'doc', 'doctor', 'Врач');
  const sup = (name) => Number(db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(name).lastInsertRowid);
  return { db, A: sup('ООО Аптека'), B: sup('ООО Бинты'), C: sup('ООО Шприцы') };
}
const links = (db, where, id) => db.prepare(`SELECT product_id, supplier_id, last_price, vat_rate, pack_factor, purchase_unit
                                              FROM item_suppliers WHERE ${where} = ? ORDER BY id`).all(id).map((r) => ({ ...r }));
const product = (db, id) => ({ ...db.prepare('SELECT * FROM products WHERE id = ?').get(id) });
const todayIso = (db) => db.prepare("SELECT date('now','localtime') AS d").get().d;
const dmy = (iso) => iso.split('-').reverse().join('.');
const shift = (db, days) => db.prepare('SELECT date(?, ?) AS d').get(todayIso(db), `${days} days`).d;

// ---------------------------------------------------------------------------
// Карточка товара
// ---------------------------------------------------------------------------
test('product_save: товар с типом, НДС, ценой продажи и двумя поставщиками — первый основной', () => {
  const { db, A, B } = seed();
  const r = call('product_save', db, {
    name: '  Парацетамол 500 мг ', procurement_category: 'medicines', base_unit: 'таб', purchase_unit: 'уп', pack_factor: 10,
    sale_price: 2500, vat_rate: 12, active: true,
    suppliers: [{ supplier_id: A, last_price: 1000, vat_rate: 12 }, { supplier_id: B, last_price: 900, vat_rate: null }],
  });
  const p = product(db, r.product.id);
  assert.equal(p.name, 'Парацетамол 500 мг');
  assert.equal(p.procurement_category, 'medicines');
  assert.equal(p.vat_rate, 12);
  assert.equal(p.sale_price, 2500);
  assert.equal(p.base_unit, 'таб');
  assert.equal(p.unit, 'таб');
  assert.equal(p.pack_factor, 10);
  assert.equal(p.supplier_id, A, 'первый поставщик в карточке — основной');
  assert.deepEqual(links(db, 'product_id', p.id), [
    { product_id: p.id, supplier_id: A, last_price: 1000, vat_rate: 12, pack_factor: 10, purchase_unit: 'уп' },
    { product_id: p.id, supplier_id: B, last_price: 900, vat_rate: null, pack_factor: 10, purchase_unit: 'уп' },
  ]);
  assert.deepEqual(r.suppliers.map((s) => s.supplier_name), ['ООО Аптека', 'ООО Бинты']);
  // Русское название типа тоже принимается; «без НДС» — NULL.
  const r2 = call('product_save', db, { name: 'Бинт', procurement_category: 'Расходники', vat_rate: null });
  assert.equal(product(db, r2.product.id).procurement_category, 'consumables');
  assert.equal(product(db, r2.product.id).vat_rate, null);
  assert.equal(product(db, r2.product.id).base_unit, 'шт');
});

test('product_save: тип и НДС — только из списка; без них новый товар не заводится', () => {
  const { db } = seed();
  const bad = (args, re) => assert.throws(() => call('product_save', db, { name: 'Х', procurement_category: 'medicines', vat_rate: 12, ...args }),
    (e) => e.status === 400 && re.test(e.message), JSON.stringify(args));
  bad({ procurement_category: 'drugs' }, /Выберите категорию товара: Медикаменты, Расходники, Оборудование, Лаб\. материалы, Стоматология, Радиология, Офис \/ IT, Хозяйство\./);
  // Фраза отказа (статья словаря) называет ровно те восемь типов, что знает сервер.
  assert.equal(CATEGORY_REQUIRED, 'Выберите категорию товара: ' + GOODS_CATEGORY_LIST_RU + '.');
  bad({ procurement_category: '' }, /Выберите категорию товара/);
  bad({ procurement_category: undefined }, /Выберите категорию товара/);
  bad({ vat_rate: 15 }, /Ставка НДС — 12 %, 0 % или «без НДС»/);
  bad({ vat_rate: '20%' }, /Ставка НДС/);
  bad({ vat_rate: undefined }, /Выберите ставку НДС/);
  bad({ name: '   ' }, /Укажите название товара/);
  bad({ sale_price: -1 }, /Цена продажи — неотрицательное число/);
  bad({ pack_factor: 0 }, /Коэффициент упаковки/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 0, 'ни одного товара из отказов');
});

test('product_save: поставщик дважды — отказ; несуществующий — отказ, и товар не заводится (одна транзакция)', () => {
  const { db, A } = seed();
  assert.throws(() => call('product_save', db, { name: 'Х', procurement_category: 'dental', vat_rate: 0,
    suppliers: [{ supplier_id: A }, { supplier_id: A }] }), (e) => e.status === 400 && /дважды/.test(e.message));
  assert.throws(() => call('product_save', db, { name: 'Х', procurement_category: 'dental', vat_rate: 0,
    suppliers: [{ supplier_id: A }, { supplier_id: 999 }] }), (e) => e.status === 404 && /Поставщик №999 не найден/.test(e.message));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM item_suppliers').get().n, 0);
  assert.throws(() => call('product_save', db, { name: 'Х', procurement_category: 'dental', vat_rate: 0,
    suppliers: [{ supplier_id: A, vat_rate: 7 }] }), (e) => e.status === 400 && /Ставка НДС/.test(e.message));
});

test('product_save, правка: список поставщиков целиком; не прислан — связи не трогаются; не присланное поле не меняется', () => {
  const { db, A, B, C } = seed();
  const id = call('product_save', db, { name: 'Шприц', procurement_category: 'consumables', purchase_unit: 'кор', pack_factor: 100, vat_rate: 12,
    suppliers: [{ supplier_id: A, last_price: 50 }, { supplier_id: B, last_price: 60 }] }).product.id;
  // Сбой загрузки связей в карточке → список не прислан → связи целы.
  call('product_save', db, { id, name: 'Шприц 5 мл', procurement_category: 'consumables', vat_rate: 0 });
  assert.equal(links(db, 'product_id', id).length, 2);
  assert.equal(product(db, id).pack_factor, 100, 'упаковку не прислали — осталась');
  assert.equal(product(db, id).purchase_unit, 'кор');
  assert.equal(product(db, id).vat_rate, 0);
  // Снять A, оставить B и добавить C: основной — первый в списке.
  call('product_save', db, { id, name: 'Шприц 5 мл', procurement_category: 'consumables', vat_rate: 0,
    suppliers: [{ supplier_id: C, last_price: 55, vat_rate: 12 }, { supplier_id: B, last_price: 61 }] });
  assert.deepEqual(links(db, 'product_id', id).map((l) => [l.supplier_id, l.last_price]), [[B, 61], [C, 55]]);
  assert.equal(product(db, id).supplier_id, C);
  call('product_save', db, { id, name: 'Шприц 5 мл', procurement_category: 'consumables', vat_rate: 0, suppliers: [] });
  assert.equal(links(db, 'product_id', id).length, 0);
  assert.equal(product(db, id).supplier_id, null);
  assert.throws(() => call('product_save', db, { id: 9999, name: 'Х', procurement_category: 'consumables', vat_rate: 0 }), (e) => e.status === 404);
});

// SUPPLIERS_VAT_V1 (ревью F1) — было «право «Закупки: Изменение»»: кладовщик
// с «Просмотром» от старого экрана «Роли» терял приход, который делал в
// 3.12.1. Кто ведёт товары — администратор и склад, как в 3.12.1; сверка всех
// дверей между собой — suppliers-vat-roles.test.js.
test('product_save / supplier_save: администратор и склад, как в 3.12.1; уровень «Закупки» не сужает и не расширяет', () => {
  const { db, A } = seed();
  const args = { name: 'Х', procurement_category: 'consumables', vat_rate: 12, suppliers: [{ supplier_id: A }] };
  assert.throws(() => call('product_save', db, args, DOC), (e) => e.status === 403 && e.message === 'Ваша роль не может выполнить это действие.');
  assert.throws(() => call('supplier_save', db, { name: 'Y' }, DOC), (e) => e.status === 403);
  assert.ok(call('product_save', db, args, ADMIN).product.id);
  // Роль склада, которой старый экран оставил «Закупки: Просмотр», — принимает и ведёт товары, как в 3.12.1.
  db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)')
    .run('inventory', JSON.stringify({ sections: ['inventory'], levels: { inventory: 'viewer' }, grants: { procurement: 'view' } }));
  assert.ok(call('product_save', db, { ...args, name: 'Y' }, INV).product.id);
  assert.equal(call('receive_stock_lines', db, { lines: [{ product_id: 1, qty: 1, unit_cost: 1 }] }, INV).received.length, 1);
  assert.equal(call('import_products_excel', db, { rows: [{ name: 'Z', category: 'Расходники' }] }, INV).created, 1);
  // …а врачу «Закупки: Изменение» в матрице товаров не открывает — как и в 3.12.1
  // (его не пускают ни /api/db, ни receive_stock, ни корректировка).
  db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)')
    .run('doctor', JSON.stringify({ sections: ['inventory'], levels: {}, grants: { procurement: 'edit' } }));
  assert.throws(() => call('product_save', db, { ...args, name: 'W' }, DOC), (e) => e.status === 403);
  // Запись — не чтение: при просроченной лицензии эти вызовы закрыты.
  for (const n of ['product_save', 'supplier_save']) assert.equal(isReadOnlyRpc(n), false, n);
});

// ---------------------------------------------------------------------------
// Карточка поставщика
// ---------------------------------------------------------------------------
test('supplier_save: поставщик со своими товарами; новая связь берёт упаковку товара; основной поставщик у товара без него', () => {
  const { db, A } = seed();
  const p1 = call('product_save', db, { name: 'Перчатки', procurement_category: 'consumables', purchase_unit: 'кор', pack_factor: 50, vat_rate: 12 }).product.id;
  const p2 = call('product_save', db, { name: 'Маски', procurement_category: 'consumables', vat_rate: 12, suppliers: [{ supplier_id: A, last_price: 10 }] }).product.id;
  const r = call('supplier_save', db, { name: ' ООО Новый ', contact_name: 'Алишер', phone: '+998901234567', notes: 'предоплата',
    products: [{ product_id: p1, last_price: 45000, vat_rate: 12 }, { product_id: p2, last_price: 12, vat_rate: null }] });
  const S = r.supplier.id;
  assert.equal(r.supplier.name, 'ООО Новый');
  assert.equal(r.supplier.contact_name, 'Алишер');
  assert.deepEqual(r.products.map((x) => [x.product_name, x.last_price, x.vat_rate]), [['Маски', 12, null], ['Перчатки', 45000, 12]]);
  assert.deepEqual(links(db, 'supplier_id', S).find((l) => l.product_id === p1), { product_id: p1, supplier_id: S, last_price: 45000, vat_rate: 12, pack_factor: 50, purchase_unit: 'кор' });
  assert.equal(product(db, p1).supplier_id, S, 'у перчаток поставщика не было — этот стал основным');
  assert.equal(product(db, p2).supplier_id, A, 'у масок основной остался прежним');
  assert.equal(links(db, 'product_id', p2).length, 2, 'у масок теперь два поставщика');

  // Правка: товары не присланы — связи и поля, которых нет в запросе, целы.
  call('supplier_save', db, { id: S, name: 'ООО Новый' });
  assert.equal(links(db, 'supplier_id', S).length, 2);
  assert.equal(db.prepare('SELECT contact_name FROM suppliers WHERE id = ?').get(S).contact_name, 'Алишер');
  // Снять перчатки: связь уходит, основной поставщик перчаток — пусто (других нет).
  call('supplier_save', db, { id: S, name: 'ООО Новый', products: [{ product_id: p2, last_price: 13, vat_rate: 12 }] });
  assert.deepEqual(links(db, 'supplier_id', S).map((l) => [l.product_id, l.last_price, l.vat_rate]), [[p2, 13, 12]]);
  assert.equal(product(db, p1).supplier_id, null);
  // Снять маски у A (основного): основной переходит к оставшемуся поставщику.
  call('supplier_save', db, { id: A, name: 'ООО Аптека', products: [] });
  assert.equal(product(db, p2).supplier_id, S);
});

test('supplier_save: товар дважды, несуществующий товар, пустое название — отказ, ничего не записано', () => {
  const { db } = seed();
  const p = call('product_save', db, { name: 'Бинт', procurement_category: 'consumables', vat_rate: 12 }).product.id;
  const before = db.prepare('SELECT COUNT(*) n FROM suppliers').get().n;
  assert.throws(() => call('supplier_save', db, { name: 'X', products: [{ product_id: p }, { product_id: p }] }), (e) => e.status === 400 && /дважды/.test(e.message));
  assert.throws(() => call('supplier_save', db, { name: 'X', products: [{ product_id: 777 }] }), (e) => e.status === 404 && /Товар №777 не найден/.test(e.message));
  assert.throws(() => call('supplier_save', db, { name: '' }), (e) => e.status === 400 && /Укажите название поставщика/.test(e.message));
  assert.throws(() => call('supplier_save', db, { name: 'X', products: [{ product_id: p, vat_rate: 20 }] }), (e) => e.status === 400 && /Ставка НДС/.test(e.message));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM suppliers').get().n, before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM item_suppliers').get().n, 0);
});

// ---------------------------------------------------------------------------
// Приход
// ---------------------------------------------------------------------------
test('приход с НДС: цена без НДС, НДС строки, себестоимость с НДС; связь помнит цену и ставку', () => {
  const { db, A } = seed();
  const p = call('product_save', db, { name: 'Анальгин', procurement_category: 'medicines', base_unit: 'таб', purchase_unit: 'уп', pack_factor: 10, vat_rate: 12 }).product.id;
  const r = call('receive_stock_lines', db, { lines: [{ product_id: p, unit: 'purchase', qty: 2, unit_cost: 1000, vat_rate: 12, supplier_id: A }] });
  assert.equal(r.received[0].vat_amount, 240);
  const m = db.prepare("SELECT qty, unit_cost, vat_rate, vat_amount, supplier_id FROM stock_movements WHERE kind = 'receive'").get();
  assert.deepEqual({ ...m }, { qty: 20, unit_cost: 112, vat_rate: 12, vat_amount: 240, supplier_id: A });
  assert.equal(product(db, p).avg_cost, 112, 'себестоимость таблетки — с НДС: 1000 × 1,12 / 10');
  assert.equal(product(db, p).on_hand, 20);
  assert.deepEqual(links(db, 'product_id', p), [{ product_id: p, supplier_id: A, last_price: 1000, vat_rate: 12, pack_factor: 10, purchase_unit: 'уп' }]);
  assert.equal(product(db, p).supplier_id, A, 'у товара без основного поставщика — поставщик прихода');

  // Второй приход того же поставщика в базовых единицах: цена связи — за упаковку.
  call('receive_stock_lines', db, { lines: [{ product_id: p, unit: 'base', qty: 5, unit_cost: 95, vat_rate: 0, supplier_id: A }] });
  assert.deepEqual(links(db, 'product_id', p).map((l) => [l.last_price, l.vat_rate]), [[950, 0]]);
  // «Без НДС» — ставка пусто, сумма 0; себестоимость = цена.
  call('receive_stock_lines', db, { lines: [{ product_id: p, unit: 'base', qty: 1, unit_cost: 100, vat_rate: null }] });
  // Старый вызов без ставки — «не указан»: обе колонки пусты, цена = себестоимость.
  call('receive_stock_lines', db, { lines: [{ product_id: p, unit: 'base', qty: 1, unit_cost: 100, supplier_id: A }] });
  const tail = db.prepare("SELECT unit_cost, vat_rate, vat_amount FROM stock_movements WHERE kind = 'receive' ORDER BY id").all().slice(1).map((x) => ({ ...x }));
  assert.deepEqual(tail, [
    { unit_cost: 95, vat_rate: 0, vat_amount: 0 },
    { unit_cost: 100, vat_rate: null, vat_amount: 0 },
    { unit_cost: 100, vat_rate: null, vat_amount: null },
  ]);
  assert.deepEqual(links(db, 'product_id', p).map((l) => [l.last_price, l.vat_rate]), [[1000, 0]],
    'приход без ставки обновил цену, но не стёр ставку поставщика');
  // Чужая ставка — отказ целиком.
  const before = db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n;
  assert.throws(() => call('receive_stock_lines', db, { lines: [
    { product_id: p, qty: 1, unit_cost: 1, vat_rate: 12 }, { product_id: p, qty: 1, unit_cost: 1, vat_rate: 15 }] }), (e) => e.status === 400 && /Ставка НДС/.test(e.message));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, before);
});

// ---------------------------------------------------------------------------
// Импорт Excel
// ---------------------------------------------------------------------------
test('импорт: тип, НДС, цена продажи, партия и срок ДД.ММ.ГГГГ; связь с поставщиком; цена больше миллиона', () => {
  const { db } = seed();
  const exp = shift(db, 400);
  const r = call('import_products_excel', db, { rows: [
    { name: 'Цефтриаксон 1 г', category: 'Медикаменты', unit: 'фл', qty: 30, unit_cost: 10000, vat_rate: '12%', sale_price: 15000,
      reorder_level: 5, supplier: 'ООО Медснаб', batch_no: 'C-2601', expiry_date: dmy(exp) },
    { name: 'УЗИ-аппарат', category: 'equipment', qty: 1, unit_cost: '1 500 000', vat_rate: 'без НДС', sale_price: 0 },
    { name: 'Шприц 5 мл', category: 'расходники', vat_rate: 0.12, supplier: 'ООО Медснаб' },   // «12%» из процентной ячейки Excel
  ] });
  assert.deepEqual(r, { created: 3, updated: 0, received: 2 });
  const cef = db.prepare("SELECT * FROM products WHERE name = 'Цефтриаксон 1 г'").get();
  assert.equal(cef.procurement_category, 'medicines');
  assert.equal(cef.vat_rate, 12);
  assert.equal(cef.sale_price, 15000);
  assert.equal(cef.avg_cost, 11200, 'себестоимость с НДС');
  const m = db.prepare("SELECT * FROM stock_movements WHERE product_id = ? AND reference_type = 'import'").get(cef.id);
  assert.equal(m.batch_no, 'C-2601');
  assert.equal(m.expiry_date, exp);
  assert.equal(m.vat_rate, 12);
  assert.equal(m.vat_amount, 36000);
  assert.equal(m.supplier_id, cef.supplier_id);
  assert.deepEqual(links(db, 'product_id', cef.id).map((l) => [l.last_price, l.vat_rate]), [[10000, 12]]);
  const uzi = db.prepare("SELECT * FROM products WHERE name = 'УЗИ-аппарат'").get();
  assert.equal(uzi.procurement_category, 'equipment');
  assert.equal(uzi.vat_rate, null);
  assert.equal(uzi.avg_cost, 1500000);
  const shp = db.prepare("SELECT * FROM products WHERE name = 'Шприц 5 мл'").get();
  assert.equal(shp.vat_rate, 12);
  assert.equal(shp.procurement_category, 'consumables');
  assert.equal(links(db, 'product_id', shp.id).length, 1, 'строка каталога без прихода — товар всё равно связан с поставщиком');

  // Существующий товар: тип и НДС не присланы — не меняются; старый шаблон работает как прежде.
  const r2 = call('import_products_excel', db, { rows: [{ name: 'Цефтриаксон 1 г', qty: 10, unit_cost: 9000 }] });
  assert.deepEqual(r2, { created: 0, updated: 1, received: 1 });
  const cef2 = db.prepare("SELECT * FROM products WHERE id = ?").get(cef.id);
  assert.equal(cef2.procurement_category, 'medicines');
  assert.equal(cef2.vat_rate, 12);
  const m2 = db.prepare("SELECT * FROM stock_movements WHERE product_id = ? AND reference_type = 'import' ORDER BY id DESC").get(cef.id);
  assert.deepEqual([m2.unit_cost, m2.vat_rate, m2.vat_amount], [9000, null, null], 'НДС в строке не указан — приход как прежде');
});

test('импорт: тип, НДС и срок годности — только из допустимого, с номером строки и словами', () => {
  const { db } = seed();
  const future = dmy(shift(db, 400));
  const fails = (row, re, rowNo = 2) => assert.throws(() => call('import_products_excel', db, { rows: [row] }),
    (e) => e.status === 400 && new RegExp('^Строка ' + rowNo + ': ').test(e.message) && re.test(e.message), JSON.stringify(row));
  fails({ name: 'А', category: 'Лекарства' }, /категория «Лекарства» — такой категории нет\. Допустимо: Медикаменты, Расходники/);
  fails({ name: 'А' }, /у нового товара «А» укажите «Категорию» — одну из: Медикаменты/);
  fails({ name: 'А', category: 'Медикаменты', vat_rate: '15%' }, /НДС «15%» — допустимо 12%, 0% или «без НДС»/);
  fails({ name: 'А', category: 'Медикаменты', qty: 1, expiry_date: '31.02.2027' }, /срок годности 31\.02\.2027 — такой даты нет; формат ДД\.ММ\.ГГГГ/);
  fails({ name: 'А', category: 'Медикаменты', qty: 1, expiry_date: '2027-12-31' }, /срок годности «2027-12-31» — неверный формат\. Нужен ДД\.ММ\.ГГГГ, например 31\.12\.2027/);
  fails({ name: 'А', category: 'Медикаменты', qty: 1, expiry_date: '31/12/2027' }, /неверный формат/);
  fails({ name: 'А', category: 'Медикаменты', qty: 1, expiry_date: 46387 }, /неверный формат/);
  fails({ name: 'А', category: 'Медикаменты', qty: 1, expiry_date: '01.01.2020' }, /срок годности 01\.01\.2020 уже прошёл/);
  fails({ name: 'А', category: 'Медикаменты', expiry_date: future }, /срок годности и партия относятся к приходу — укажите «Кол-во»/);
  fails({ name: 'А', category: 'Медикаменты', batch_no: 'B-1' }, /укажите «Кол-во»/);
  fails({ name: 'А', category: 'Медикаменты', sale_price: 'дорого' }, /«Цена продажи» должно быть числом/);
  // Шаблон сообщения едет вместе с ним — экран переводит его на язык интерфейса.
  try { call('import_products_excel', db, { rows: [{ name: 'А', category: 'Медикаменты', qty: 1, expiry_date: '31.02.2027' }] }); }
  catch (e) {
    assert.equal(e.template, 'Строка {row}: срок годности {value} — такой даты нет; формат ДД.ММ.ГГГГ.');
    assert.deepEqual(e.params, { row: 2, value: '31.02.2027' });
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 0);
});

test('импорт — всё или ничего: ошибка в третьей строке не оставляет ни товаров, ни поставщиков, ни связей, ни прихода', () => {
  const { db } = seed();
  const before = { s: db.prepare('SELECT COUNT(*) n FROM suppliers').get().n };
  assert.throws(() => call('import_products_excel', db, { rows: [
    { name: 'Товар 1', category: 'Медикаменты', qty: 5, unit_cost: 100, vat_rate: 12, supplier: 'ООО Новый', expiry_date: dmy(shift(db, 30)) },
    { name: 'Товар 2', category: 'Стоматология', qty: 1 },
    { name: 'Товар 3', category: 'Медикаменты', qty: 1, expiry_date: '30.02.2030' },
  ] }), (e) => /^Строка 4: /.test(e.message));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM suppliers').get().n, before.s);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM item_suppliers').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, 0);
});
