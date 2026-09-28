// SUPPLIERS_VAT_V1 (2026-09-28) — КАРТОЧКА ТОВАРА И КАРТОЧКА ПОСТАВЩИКА ПИШУТ
// ЧЕРЕЗ СЕРВЕР, ВМЕСТЕ СО СВЯЗЯМИ «ТОВАР ↔ ПОСТАВЩИК».
//
// Владелец: «connect the providers to the drug products and add products
// (connect products to the providers). One provider can have multiple drugs
// and multiple drugs can have multiple products». Решение: многие ко многим и
// с обеих сторон — у товара список его поставщиков (с ценой закупки и НДС
// каждого), у поставщика список его товаров с кнопкой «Добавить товар».
//
// ПОЧЕМУ RPC, А НЕ /api/db. Карточка товара писала товар, потом по одной
// строке удаляла, правила и вставляла связи — пять-десять запросов без общей
// транзакции: оборвалось на середине — товар сохранён, поставщики наполовину.
// И каждое значение (тип, ставка НДС, цена) проверял только браузер. Здесь —
// одна транзакция, одна проверка и одно право:
//   • категория товара — одна из восьми (goods-catalog.js), иначе отказ
//     словами, а не «CHECK constraint failed»;
//   • НДС — 12 %, 0 % или «без НДС», и у товара, и у каждой связи;
//   • связь одна на пару «товар — поставщик» (UNIQUE в базе); поставщик,
//     присланный дважды, — отказ, а не молчаливая вторая строка;
//   • кто — администратор и склад, как в 3.12.1 (CATALOG_ROLES ниже). Запись
//     связей через /api/db закрыта в реестре.
//
// СПИСОК СВЯЗЕЙ — ЦЕЛИКОМ. Карточка присылает всех поставщиков товара (или все
// товары поставщика); кого в списке нет — связь снимается. Не прислала список
// вовсе (не загрузился) — связи не трогаются: иначе сбой сети при открытии
// карточки стирал бы их все при «Сохранить».
import { rpcT } from '../server-message.js';
import { hasAnyRole } from '../roles.js';
import { parseGoodsCategory, parseVatRate, packOf, linkPackOf, priceInLinkPack } from '../../../public/js/shared/goods-catalog.js';

export class RpcError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

// SUPPLIERS_VAT_V1 (ревью F1) — КТО ВЕДЁТ ТОВАРЫ, ПОСТАВЩИКОВ И ПРИХОД: РОВНО ТЕ,
// КТО ДЕЛАЛ ЭТО В 3.12.1, — администратор и склад (основной или
// дополнительной ролью; своя роль клиники — по основе, users.role).
//
// Первая версия ветки поставила сюда ворота «Закупки: Изменение» (requireGrant).
// Они заперли кладовщика, которому старый экран «Роли» сохранил «Закупки:
// Просмотр» (отпечаток миграции 215): в 3.12.1 он принимал товар, а после
// обновления получил бы 403 на приходе, заказе и импорте. И заперли не до
// конца: старый receive_stock, adjust_stock и прямая запись в products /
// suppliers / purchase_orders через /api/db его по-прежнему пускали.
//
// Почему не уровень «Закупки», даже «только для тех, кто выбрал его сам».
// Выбор человека от сохранения старого экрана не отличить (миграция 215 —
// «те же байты»), а врач с дополнительной ролью «Склад», чья основная роль
// видит склад на просмотр, получил бы «Просмотр» по правилу «самая щедрая из
// НАСТРОЕННЫХ» (grants.js grantLevel) — дополнительная роль в нём не в счёт.
// Миграция, поднимающая «Просмотр» до «Изменения», вернула бы приход, но
// заодно раздала бы то, что «Изменение» даёт сверх него (заявки и минимумы
// всех отделов). Владелец просил одно новое ограничение — выдачу пациенту со
// склада, — поэтому здесь не сужается никто: один список ролей на все двери
// (приход, приход по заказу, заказ, импорт, карточки товара и поставщика,
// старый receive_stock, корректировка и реестр /api/db — у всех он один и тот
// же). Тест suppliers-vat-roles.test.js сверяет двери между собой.
export const CATALOG_ROLES = ['admin', 'inventory'];
export function requireCatalogEdit(_db, user) {
  if (!hasAnyRole(user, CATALOG_ROLES)) throw new RpcError('Ваша роль не может выполнить это действие.', 403);
}

const MAX_NAME = 200;
const MAX_UNIT = 40;
const MAX_MONEY = 1e12;
const MAX_FACTOR = 1_000_000;
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Управляющие символы — вон: имена печатаются в журнале и уходят в Excel.
function text(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\x00-\x1F\x7F]+/g, ' ').trim().slice(0, max);
}

// refusal — готовая фраза отказа (переводится словарём целиком).
function money(v, refusal) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) throw new RpcError(refusal, 400);
  return round2(n);
}
const SALE_PRICE_BAD = 'Цена продажи — неотрицательное число.';
const PURCHASE_PRICE_BAD = 'Цена закупки — неотрицательное число.';

function factor(v) {
  if (v === undefined || v === null || v === '') return 1;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_FACTOR) {
    throw new RpcError('Коэффициент упаковки — положительное число.', 400);
  }
  return n;
}

/** Ставка НДС (12 | 0 | null). Пусто — required ? отказ : undefined («не менять»). */
function vatOf(v, { required = false } = {}) {
  const p = parseVatRate(v);
  if (p.error) throw new RpcError('Ставка НДС — 12 %, 0 % или «без НДС».', 400);
  if (p.empty) {
    if (required) throw new RpcError('Выберите ставку НДС: 12 %, 0 % или «без НДС».', 400);
    return undefined;
  }
  return p.rate;
}

// Список типов — в самой фразе: экран переводит её целиком, и узбекский
// кладовщик читает названия своими словами (GOODS_CATEGORY_LIST_RU — тот же
// список, тест сверяет).
export const CATEGORY_REQUIRED = 'Выберите категорию товара: Медикаменты, Расходники, Оборудование, Лаб. материалы, Стоматология, Радиология, Офис / IT, Хозяйство.';
function categoryOf(v) {
  const c = parseGoodsCategory(v);
  if (!c) throw new RpcError(CATEGORY_REQUIRED, 400);
  return c;
}

// refusal — фраза отказа для неверного id («Товар указан неверно.»).
function readId(v, refusal) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!isPosInt(n)) throw new RpcError(refusal, 400);
  return n;
}
const PRODUCT_ID_BAD = 'Товар указан неверно.';
const SUPPLIER_ID_BAD = 'Поставщик указан неверно.';

// Товар и его связи — в том виде, в каком их ждут карточки.
function productRow(db, id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id) || null;
}
function productLinks(db, productId) {
  return db.prepare(`SELECT l.id, l.product_id, l.supplier_id, l.last_price, l.vat_rate, l.pack_factor, l.purchase_unit,
                            s.name AS supplier_name, s.active AS supplier_active
                       FROM item_suppliers l JOIN suppliers s ON s.id = l.supplier_id
                      WHERE l.product_id = ? ORDER BY l.id`).all(productId);
}
function supplierLinks(db, supplierId) {
  return db.prepare(`SELECT l.id, l.product_id, l.supplier_id, l.last_price, l.vat_rate, l.pack_factor, l.purchase_unit,
                            p.name AS product_name, p.procurement_category, p.base_unit, p.sale_price,
                            p.vat_rate AS product_vat_rate, p.active AS product_active
                       FROM item_suppliers l JOIN products p ON p.id = l.product_id
                      WHERE l.supplier_id = ? ORDER BY p.name, l.id`).all(supplierId);
}

// «Основной поставщик» товара (products.supplier_id: колонка «Поставщик» на
// «Складе», поставщик строки прихода по умолчанию) — всегда один из его связей
// или пусто. Снятая связь с основным поставщиком отдаёт роль следующей связи.
function settleDefaultSupplier(db, productId) {
  const p = db.prepare('SELECT supplier_id FROM products WHERE id = ?').get(productId);
  if (!p) return;
  const linked = db.prepare('SELECT supplier_id FROM item_suppliers WHERE product_id = ? ORDER BY id').all(productId).map((r) => r.supplier_id);
  if (p.supplier_id != null && linked.includes(p.supplier_id)) return;
  const next = linked.length ? linked[0] : null;
  if (next !== p.supplier_id) db.prepare(`UPDATE products SET supplier_id = ?, updated_at = ${NOW} WHERE id = ?`).run(next, productId);
}

/**
 * product_save — карточка товара целиком.
 * args: { id?, name, procurement_category, base_unit?, purchase_unit?, pack_factor?,
 *         sale_price?, vat_rate, active?,
 *         suppliers?: [{ supplier_id, last_price?, vat_rate?, pack_factor?, purchase_unit? }] }
 * Порядок поставщиков — порядок карточки; первый — основной (products.supplier_id).
 */
export function productSave(db, args, user) {
  requireCatalogEdit(db, user);
  const a = args || {};
  const id = readId(a.id, PRODUCT_ID_BAD);
  const name = text(a.name, MAX_NAME + 1);
  if (!name) throw new RpcError('Укажите название товара.', 400);
  if (name.length > MAX_NAME) throw new RpcError('Название товара — не длиннее 200 символов.', 400);
  const category = categoryOf(a.procurement_category);
  // Не присланное поле у ПРАВКИ не меняется (undefined), у НОВОГО товара —
  // значение по умолчанию. Пустая строка единицы — «шт», как и в форме.
  const baseUnit = a.base_unit === undefined ? undefined : (text(a.base_unit, MAX_UNIT) || 'шт');
  const purchaseUnit = a.purchase_unit === undefined ? undefined : (text(a.purchase_unit, MAX_UNIT) || null);
  const pack = a.pack_factor === undefined ? undefined : factor(a.pack_factor);
  const salePrice = money(a.sale_price, SALE_PRICE_BAD);
  const vat = vatOf(a.vat_rate, { required: id == null || a.vat_rate !== undefined });
  const active = a.active === undefined ? null : (a.active ? 1 : 0);

  let links;
  if (a.suppliers !== undefined) {
    if (!Array.isArray(a.suppliers)) throw new RpcError('Поставщики товара переданы неверно.', 400);
    const seen = new Set();
    links = a.suppliers.map((l) => {
      if (!l || typeof l !== 'object') throw new RpcError('Поставщики товара переданы неверно.', 400);
      const sid = readId(l.supplier_id, SUPPLIER_ID_BAD);
      if (!sid) throw new RpcError('Поставщик не выбран.', 400);
      if (seen.has(sid)) throw new RpcError('Один и тот же поставщик выбран дважды.', 400);
      seen.add(sid);
      const lv = vatOf(l.vat_rate);
      return {
        supplierId: sid,
        lastPrice: money(l.last_price, PURCHASE_PRICE_BAD),
        vat: lv === undefined ? null : lv,
        pack: l.pack_factor === undefined || l.pack_factor === null || l.pack_factor === '' ? null : factor(l.pack_factor),
        unit: text(l.purchase_unit, MAX_UNIT) || null,
      };
    });
  }

  const run = db.transaction(() => {
    let productId = id;
    let saved;
    if (id != null) {
      const cur = productRow(db, id);
      if (!cur) throw new RpcError('Товар не найден.', 404);
      const unit = baseUnit === undefined ? cur.base_unit : baseUnit;
      saved = { pack: pack === undefined ? cur.pack_factor : pack, purchaseUnit: purchaseUnit === undefined ? cur.purchase_unit : purchaseUnit };
      db.prepare(`UPDATE products SET name = ?, procurement_category = ?, base_unit = ?, unit = ?, purchase_unit = ?,
                         pack_factor = ?, sale_price = ?, vat_rate = ?, active = ?, updated_at = ${NOW}
                   WHERE id = ?`)
        .run(name, category, unit, baseUnit === undefined ? cur.unit : unit, saved.purchaseUnit, saved.pack,
          salePrice === null ? cur.sale_price : salePrice,
          vat === undefined ? cur.vat_rate : vat,
          active === null ? cur.active : active, id);
    } else {
      const unit = baseUnit === undefined ? 'шт' : baseUnit;
      saved = { pack: pack === undefined ? 1 : pack, purchaseUnit: purchaseUnit === undefined ? null : purchaseUnit };
      productId = Number(db.prepare(`INSERT INTO products (name, procurement_category, base_unit, unit, purchase_unit, pack_factor, sale_price, vat_rate, active)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(name, category, unit, unit, saved.purchaseUnit, saved.pack, salePrice === null ? 0 : salePrice, vat, active === null ? 1 : active).lastInsertRowid);
    }

    if (links) {
      for (const l of links) {
        if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(l.supplierId)) {
          throw rpcT(RpcError, 'Поставщик №{id} не найден.', { id: l.supplierId }, 404);
        }
      }
      const keep = new Set(links.map((l) => l.supplierId));
      for (const ex of db.prepare('SELECT id, supplier_id FROM item_suppliers WHERE product_id = ?').all(productId)) {
        if (!keep.has(ex.supplier_id)) db.prepare('DELETE FROM item_suppliers WHERE id = ?').run(ex.id);
      }
      const up = db.prepare(`INSERT INTO item_suppliers (product_id, supplier_id, last_price, vat_rate, pack_factor, purchase_unit)
                             VALUES (?, ?, ?, ?, ?, ?)
                             ON CONFLICT (product_id, supplier_id) DO UPDATE SET
                               last_price = excluded.last_price, vat_rate = excluded.vat_rate,
                               pack_factor = excluded.pack_factor, purchase_unit = excluded.purchase_unit`);
      // Упаковка и единица связи — свои у поставщика, если их прислали; иначе
      // как у товара.
      for (const l of links) up.run(productId, l.supplierId, l.lastPrice, l.vat, l.pack ?? saved.pack, l.unit ?? saved.purchaseUnit);
      // Первый в карточке — основной; снятый основной уступает место следующему.
      db.prepare(`UPDATE products SET supplier_id = ?, updated_at = ${NOW} WHERE id = ?`)
        .run(links.length ? links[0].supplierId : null, productId);
    }
    return { product: productRow(db, productId), suppliers: productLinks(db, productId) };
  });
  return run();
}

/**
 * supplier_save — карточка поставщика целиком.
 * args: { id?, name, contact_name?, phone?, email?, notes?, active?,
 *         products?: [{ product_id, last_price?, vat_rate? }] }
 * Новая связь берёт единицу закупки и упаковку у товара; у прежней меняются
 * только цена и НДС (единицу связи правят в карточке товара).
 */
export function supplierSave(db, args, user) {
  requireCatalogEdit(db, user);
  const a = args || {};
  const id = readId(a.id, SUPPLIER_ID_BAD);
  const name = text(a.name, MAX_NAME + 1);
  if (!name) throw new RpcError('Укажите название поставщика.', 400);
  if (name.length > MAX_NAME) throw new RpcError('Название поставщика — не длиннее 200 символов.', 400);
  const fields = {
    contact_name: a.contact_name === undefined ? undefined : text(a.contact_name, MAX_NAME),
    phone: a.phone === undefined ? undefined : text(a.phone, 40),
    email: a.email === undefined ? undefined : text(a.email, MAX_NAME),
    notes: a.notes === undefined ? undefined : text(a.notes, 1000),
  };
  const active = a.active === undefined ? null : (a.active ? 1 : 0);

  let links;
  if (a.products !== undefined) {
    if (!Array.isArray(a.products)) throw new RpcError('Товары поставщика переданы неверно.', 400);
    const seen = new Set();
    links = a.products.map((l) => {
      if (!l || typeof l !== 'object') throw new RpcError('Товары поставщика переданы неверно.', 400);
      const pid = readId(l.product_id, PRODUCT_ID_BAD);
      if (!pid) throw new RpcError('Товар не выбран.', 400);
      if (seen.has(pid)) throw new RpcError('Один и тот же товар выбран дважды.', 400);
      seen.add(pid);
      const lv = vatOf(l.vat_rate);
      return { productId: pid, lastPrice: money(l.last_price, PURCHASE_PRICE_BAD), vat: lv === undefined ? null : lv };
    });
  }

  const run = db.transaction(() => {
    let supplierId = id;
    if (id != null) {
      const cur = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
      if (!cur) throw new RpcError('Поставщик не найден.', 404);
      const v = (k) => (fields[k] === undefined ? cur[k] : fields[k]);
      db.prepare('UPDATE suppliers SET name = ?, contact_name = ?, phone = ?, email = ?, notes = ?, active = ? WHERE id = ?')
        .run(name, v('contact_name'), v('phone'), v('email'), v('notes'), active === null ? cur.active : active, id);
    } else {
      const v = (k) => (fields[k] === undefined ? null : fields[k]);
      supplierId = Number(db.prepare('INSERT INTO suppliers (name, contact_name, phone, email, notes, active) VALUES (?, ?, ?, ?, ?, ?)')
        .run(name, v('contact_name'), v('phone'), v('email'), v('notes'), active === null ? 1 : active).lastInsertRowid);
    }

    if (links) {
      const products = new Map();
      for (const l of links) {
        const p = db.prepare('SELECT id, pack_factor, purchase_unit FROM products WHERE id = ?').get(l.productId);
        if (!p) throw rpcT(RpcError, 'Товар №{id} не найден.', { id: l.productId }, 404);
        products.set(l.productId, p);
      }
      const keep = new Set(links.map((l) => l.productId));
      const dropped = [];
      for (const ex of db.prepare('SELECT id, product_id FROM item_suppliers WHERE supplier_id = ?').all(supplierId)) {
        if (!keep.has(ex.product_id)) {
          db.prepare('DELETE FROM item_suppliers WHERE id = ?').run(ex.id);
          dropped.push(ex.product_id);
        }
      }
      const up = db.prepare(`INSERT INTO item_suppliers (product_id, supplier_id, last_price, vat_rate, pack_factor, purchase_unit)
                             VALUES (?, ?, ?, ?, ?, ?)
                             ON CONFLICT (product_id, supplier_id) DO UPDATE SET
                               last_price = excluded.last_price, vat_rate = excluded.vat_rate`);
      for (const l of links) {
        const p = products.get(l.productId);
        up.run(l.productId, supplierId, l.lastPrice, l.vat, p.pack_factor, p.purchase_unit);
        // У товара без основного поставщика основным становится этот.
        db.prepare(`UPDATE products SET supplier_id = ?, updated_at = ${NOW} WHERE id = ? AND supplier_id IS NULL`).run(supplierId, l.productId);
      }
      for (const pid of dropped) settleDefaultSupplier(db, pid);
    }
    return { supplier: db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId), products: supplierLinks(db, supplierId) };
  });
  return run();
}

/**
 * Приход и импорт помнят цену и НДС поставщика: связь заводится, если её не
 * было, и получает последнюю цену закупки (без НДС, за единицу закупки СВЯЗИ).
 * vat === undefined — ставку не прислали: у прежней связи она не меняется.
 *
 * SUPPLIERS_VAT_V1 (ревью F2) — `price` — цена без НДС за `per` базовых
 * единиц (1 — за базовую единицу; упаковка товара — за его единицу закупки).
 * Связь хранит цену в СВОЕЙ упаковке (у поставщика «кор = 100 таб», у товара
 * «уп = 10 таб»), и сама упаковка связи здесь не меняется — её правят в
 * карточке товара. Связи ещё не было — заводится в упаковке товара
 * (`packFactor`, `purchaseUnit`), и цена — в ней же.
 */
export function rememberSupplierPrice(db, { productId, supplierId, price, per = 1, vat, packFactor, purchaseUnit }) {
  const keepVat = vat === undefined;
  const cur = db.prepare('SELECT pack_factor FROM item_suppliers WHERE product_id = ? AND supplier_id = ?').get(productId, supplierId);
  const lastPrice = priceInLinkPack(price, per, cur ? linkPackOf(cur, { pack_factor: packFactor }) : (packOf(packFactor) || 1));
  db.prepare(`INSERT INTO item_suppliers (product_id, supplier_id, last_price, vat_rate, pack_factor, purchase_unit)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (product_id, supplier_id) DO UPDATE SET
                last_price = excluded.last_price,
                vat_rate = CASE WHEN ? THEN item_suppliers.vat_rate ELSE excluded.vat_rate END`)
    .run(productId, supplierId, lastPrice, keepVat ? null : vat, packFactor ?? null, purchaseUnit ?? null, keepVat ? 1 : 0);
  db.prepare(`UPDATE products SET supplier_id = ?, updated_at = ${NOW} WHERE id = ? AND supplier_id IS NULL`).run(supplierId, productId);
}
