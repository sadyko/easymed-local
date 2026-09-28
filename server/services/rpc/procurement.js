// Server-side procurement RPCs: unit-aware multi-line receiving with
// weighted-average costing (WAC), and manual stock adjustments. Both run
// inside db.transaction(...)() so a rejected line/adjustment leaves
// on_hand, avg_cost, and stock_movements completely untouched.
//
// Unit model: base_unit is the unit stock is held in. A receive line may be
// given in 'base' units or 'purchase' units (pack_factor base units per
// purchase unit). All stock quantities and the running average cost are
// always expressed in base units.

import { rpcT } from '../server-message.js';   // V3120_I18N — собранные фразы переводятся на экране
import { hasAnyRole } from '../roles.js';
import { resolveHolder, moveHolding } from './holdings.js';   // HOLDINGS_V1
import { requireGrant } from '../grants.js';                  // GRANTS_V1 — выдача со склада по матрице прав
import { logDepartmentEvent } from './departments.js';       // DEPARTMENTS_V1 — журнал отдела
// EXPIRY_BALANCE_V1 — «выдача и списание просроченного предупреждают» (владелец
// 23.09). Предупреждение считается СЕРВЕРОМ и едет в ответе: экранов выдачи
// два (склад и карточка отдела), а слов о просрочке должно быть одно.
import { expiryWarnings } from './expiry.js';
// STOCK_REQUEST_V1 — ядро заявки (номер, держатель, строки, журнал отдела) одно
// на ручную заявку отдела, заявку себе/отделу и автозаявку по минимуму.
import { insertRequisition, parseRequisitionLines, REQUISITION_ROLES } from './stock-requests.js';
// STOCK_QTY_V1 (V3120_FIX) — количества с шестью знаками, пыль округления —
// ноль (domain/stock-qty.js). round2 ниже остаётся только у денег.
import { roundQty, factorOf, toBase, settleQty, coversQty } from '../domain/stock-qty.js';
// SUPPLIERS_VAT_V1 — тип товара, ставка НДС и срок годности импорта: один
// список на сервер и экран; приход помнит цену и НДС поставщика.
import {
  GOODS_CATEGORY_LIST_RU, parseGoodsCategory, parseVatRate, vatOnNet, parseExpiryDmy, linkPriceFor,
} from '../../../public/js/shared/goods-catalog.js';
import { requireCatalogEdit, rememberSupplierPrice } from './catalog-goods.js';
import { today } from '../domain/day.js';   // SUPPLIERS_VAT_V1 — номер заказа по дню клиники

export class RpcError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

const PROCUREMENT_ROLES = ['admin', 'inventory'];

function requireRole(user, allowed) {
  // MULTI_ROLE_SERVER_V1 — extras count too, not the primary role alone.
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError('Ваша роль не может выполнить это действие.', 403);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

// No clinic single line legitimately exceeds this. See inventory.js for the
// same MAX_QTY guard and rationale (overflow to Infinity would defeat
// downstream negative-stock checks).
const MAX_QTY = 1_000_000;

const RECEIVE_UNITS = ['base', 'purchase'];
const MAX_RECEIPT_MONEY = 1e12;   // ревью M7 — тот же потолок денег, что у импорта и заказа

function validateLine(line) {
  if (!line || typeof line !== 'object') {
    throw new RpcError('Строка прихода заполнена неверно.', 400);
  }
  const productId = line.product_id;
  if (!isPositiveInt(productId)) {
    throw new RpcError('Товар не выбран.', 400);
  }
  const qty = line.qty;
  if (!(typeof qty === 'number' && Number.isFinite(qty) && qty > 0 && qty <= MAX_QTY)) {
    throw rpcT(RpcError, 'Количество — положительное число, не больше {max}.', { max: MAX_QTY }, 400);
  }
  const unit = line.unit === undefined ? 'base' : line.unit;
  if (!RECEIVE_UNITS.includes(unit)) {
    throw new RpcError('Единица: базовая или единица закупки.', 400);
  }
  const unitCost = line.unit_cost === undefined ? 0 : line.unit_cost;
  // Ревью M7 — потолок цены, как у импорта и заказа (1e12): 1e308 × 1,12 уходило
  // в бесконечность, и в базе оставались avg_cost и vat_amount = NULL.
  if (!(typeof unitCost === 'number' && Number.isFinite(unitCost) && unitCost >= 0 && unitCost <= MAX_RECEIPT_MONEY)) {
    throw new RpcError('Цена за единицу — неотрицательное число.', 400);
  }
  return { productId, qty, unit, unitCost };
}

// V3120_FIX — партия и срок строки прихода: одно правило на приход вручную и
// приход по заказу. Пусто — нет партии / нет срока.
function readBatch(l) {
  return (l && typeof l.batch_no === 'string' ? l.batch_no.trim().slice(0, 80) : '') || null;
}
function readExpiry(l) {
  if (!l || l.expiry_date === undefined || l.expiry_date === null || l.expiry_date === '') return null;
  const s = String(l.expiry_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s + 'T00:00:00Z'))) {
    throw new RpcError('Срок годности — дата в формате ГГГГ-ММ-ДД.', 400);
  }
  return s;
}

// SUPPLIERS_VAT_V1 — ставка НДС строки прихода. undefined — ставку не
// прислали вовсе (старые вызовы): НДС «не указан», цена — себестоимость, как
// прежде. null — «без НДС». Всё, кроме 12 / 0 / null, — отказ.
function readVat(l) {
  if (!l || l.vat_rate === undefined) return undefined;
  const p = parseVatRate(l.vat_rate);
  if (p.error) throw new RpcError('Ставка НДС — 12 %, 0 % или «без НДС».', 400);
  return p.empty ? undefined : p.rate;
}

// SUPPLIERS_VAT_V1 — ДЕНЬГИ СТРОКИ ПРИХОДА, ОДНО ПРАВИЛО НА ПРИХОД И ИМПОРТ.
// unitCost — цена за единицу строки БЕЗ НДС (как в счёте-фактуре поставщика),
// vat — ставка (undefined — не указана). НДС строки = сумма без НДС × ставка;
// себестоимость на складе — С НДС: столько клиника заплатила, и по ней идёт
// средняя цена (WAC). Без ставки (undefined, null, 0) цена и есть себестоимость.
//
// Ревью M3 — net: сумма строки без НДС РОВНО КАК ЕЁ ВВЕЛИ (количество × цена
// строки, до деления на упаковку) — её пишет stock_movements.net_amount (мигр.
// 224). Себестоимость единицы округлена до тийина после деления на упаковку, и
// «количество × себестоимость» расходилось со счётом-фактурой: 100 кор по 3 шт
// по 100 000 давали 9 999 999 вместо 10 000 000.
function receiptMoney(unitCost, qty, vat) {
  const rate = Number(vat) || 0;
  return {
    grossUnit: rate > 0 ? unitCost * (100 + rate) / 100 : unitCost,
    vatRate: vat === undefined ? null : vat,
    vatAmount: vat === undefined ? null : vatOnNet(unitCost * qty, vat),
    net: round2(unitCost * qty),
  };
}

export function receiveStockLines(db, args, user) {
  // SUPPLIERS_VAT_V1 (ревью F1) — приход пишет цены и НДС, а принимают его те
  // же, что в 3.12.1: администратор и склад (catalog-goods.js CATALOG_ROLES).
  requireCatalogEdit(db, user);

  const rawLines = args && args.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new RpcError('Добавьте хотя бы одну строку.', 400);
  }
  // RECEIVE_EASYMED_V1 — каждая строка может нести поставщика, партию/серию и
  // срок годности (mig 037); всё опционально и валидируется здесь.
  const lines = rawLines.map((l) => {
    const base = validateLine(l);
    let supplierId = null;
    if (l.supplier_id !== undefined && l.supplier_id !== null && l.supplier_id !== '') {
      if (!isPositiveInt(l.supplier_id)) throw new RpcError('Поставщик выбран неверно.', 400);
      supplierId = l.supplier_id;
    }
    return { ...base, supplierId, batchNo: readBatch(l), expiry: readExpiry(l), vat: readVat(l) };
  });
  const note = (args && args.note) || '';

  const run = db.transaction(() => {
    const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
    const updateProduct = db.prepare(`
      UPDATE products
      SET on_hand = ?, avg_cost = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, note, created_by, branch_id, supplier_id, batch_no, expiry_date, vat_rate, vat_amount, net_amount)
      VALUES (?, 'receive', ?, ?, 'manual', ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `);

    const received = [];
    for (const { productId, qty, unit, unitCost, supplierId, batchNo, expiry, vat } of lines) {
      const product = getProduct.get(productId);
      if (!product) {
        throw new RpcError('Товар не найден.', 400);
      }
      if (supplierId && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) {
        throw new RpcError('Поставщик не найден.', 400);
      }

      const packFactor = product.pack_factor > 0 ? product.pack_factor : 1;
      const factor = unit === 'purchase' ? packFactor : 1;
      const baseQty = roundQty(qty * factor);
      const m = receiptMoney(unitCost, qty, vat);
      const costPerBase = round2(factor > 0 ? m.grossUnit / factor : m.grossUnit);

      const oldOnHand = product.on_hand;
      const newOnHand = settleQty(oldOnHand + baseQty, factorOf(product));
      if (!Number.isFinite(newOnHand)) {
        throw new RpcError('Остаток вне допустимого диапазона.', 400);
      }
      const newAvg = newOnHand > 0
        ? round2((product.avg_cost * oldOnHand + baseQty * costPerBase) / newOnHand)
        : product.avg_cost;

      updateProduct.run(newOnHand, newAvg, productId);
      insertMovement.run(productId, baseQty, costPerBase, note, user.id, supplierId, batchNo, expiry, m.vatRate, m.vatAmount, m.net);
      // SUPPLIERS_VAT_V1 — связь «товар ↔ поставщик»: заводится, если её не
      // было, и помнит последнюю цену (без НДС) и ставку. Ревью F2: цена строки
      // — за factor базовых единиц, а связь хранит её в СВОЕЙ упаковке.
      if (supplierId) {
        rememberSupplierPrice(db, {
          productId, supplierId, vat, price: unitCost, per: factor,
          packFactor: product.pack_factor, purchaseUnit: product.purchase_unit,
        });
      }

      const fresh = getProduct.get(productId);
      received.push({ product_id: productId, base_qty: baseQty, on_hand: fresh.on_hand, avg_cost: fresh.avg_cost,
        vat_rate: m.vatRate, vat_amount: m.vatAmount });
    }

    return { received };
  });

  return run();
}

// Weighted-average cost after adding `addQty` base units at `costPerUnit` each.
function wac(oldOnHand, oldAvg, addQty, costPerUnit) {
  const newOnHand = roundQty(oldOnHand + addQty);
  const newAvg = newOnHand > 0
    ? round2((oldAvg * oldOnHand + addQty * costPerUnit) / newOnHand)
    : oldAvg;
  return { newOnHand, newAvg };
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

// -----------------------------------------------------------------------------
// receive_purchase_order — book a delivery against a PO into the warehouse.
// args: { po_id, lines?: [{ po_item_id, qty, batch_no?, expiry_date? }] }
// V3120_FIX — движение прихода несёт поставщика ЗАКАЗА и партию/срок строки:
// без них приход по заказу выпадал из «Сроков годности» и из отбора по
// поставщику (приход вручную писал их всегда).
//   • lines omitted  -> receive every line's full outstanding quantity
//   • lines provided -> receive exactly those base-unit quantities (partial OK)
// Each receipt raises on_hand + moving-average cost (WAC) at the line's
// unit_cost, writes a 'receive' stock_movement (ref purchase_order/po_id), and
// bumps po_item.qty_received. The PO becomes 'received' once every line is
// fully received, otherwise 'partial'. Cost is held in base units.
//
// SUPPLIERS_VAT_V1 (2026-09-28) — строка заказа несёт цену БЕЗ НДС и ставку
// (мигр. 223): приход пишет в движение ставку и НДС ПРИНЯТОГО количества, а
// себестоимость считает с НДС — то же правило, что у «Принять товар»
// (receiptMoney). Строка заказа до НДС (обе колонки пусты) — «не указан»,
// цена — себестоимость, как прежде. Связь «товар ↔ поставщик заказа» помнит
// цену (за единицу закупки) и ставку. Кто — администратор и склад, как в 3.12.1.
// -----------------------------------------------------------------------------
export function receivePurchaseOrder(db, args, user) {
  requireCatalogEdit(db, user);

  const poId = args && args.po_id;
  if (!isPositiveInt(poId)) {
    throw new RpcError('Заказ не выбран.', 400);
  }
  const rawLines = args && args.lines;
  if (rawLines !== undefined && !Array.isArray(rawLines)) {
    throw new RpcError('Строки прихода переданы неверно.', 400);
  }
  const PO_STATUS_RU = { received: 'уже принят', cancelled: 'отменён' };

  const run = db.transaction(() => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
    if (!po) throw new RpcError('Заказ не найден.', 400);
    if (po.status === 'received' || po.status === 'cancelled') {
      throw new RpcError(`Заказ ${PO_STATUS_RU[po.status]}.`, 400);
    }

    const items = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(poId);
    if (items.length === 0) throw new RpcError('В заказе нет строк.', 400);
    const byId = new Map(items.map((it) => [it.id, it]));
    const outstanding = (it) => roundQty(it.qty_ordered - it.qty_received);

    // Resolve how much to receive per line.
    const plan = [];   // [{ item, qty, batchNo, expiry }]
    if (Array.isArray(rawLines) && rawLines.length > 0) {
      for (const l of rawLines) {
        const it = byId.get(l && l.po_item_id);
        if (!it) throw new RpcError('Строка не из этого заказа.', 400);
        const qty = l.qty;
        if (!(typeof qty === 'number' && Number.isFinite(qty) && qty > 0 && qty <= MAX_QTY)) {
          throw rpcT(RpcError, 'Количество — положительное число, не больше {max}.', { max: MAX_QTY }, 400);
        }
        if (qty > outstanding(it) + 1e-9) {
          throw new RpcError('Количество больше, чем осталось принять по строке.', 400);
        }
        plan.push({ item: it, qty: roundQty(qty), batchNo: readBatch(l), expiry: readExpiry(l) });
      }
    } else {
      for (const it of items) {
        const out = outstanding(it);
        if (out > 0) plan.push({ item: it, qty: out, batchNo: null, expiry: null });
      }
    }
    if (plan.length === 0) throw new RpcError('По заказу нечего принимать.', 400);

    const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
    const updateProduct = db.prepare(`UPDATE products SET on_hand = ?, avg_cost = ?, updated_at = ${NOW} WHERE id = ?`);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, note, created_by, branch_id, supplier_id, batch_no, expiry_date, vat_rate, vat_amount, net_amount)
      VALUES (?, 'receive', ?, ?, 'purchase_order', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`);
    const bumpReceived = db.prepare('UPDATE purchase_order_items SET qty_received = round(qty_received + ?, 6) WHERE id = ?');

    const received = [];
    for (const { item, qty, batchNo, expiry } of plan) {
      const product = getProduct.get(item.product_id);
      if (!product) throw new RpcError('Товар строки заказа не найден.', 400);
      // Ставка строки заказа: обе колонки пусты — «не указан» (заказ до НДС).
      const vat = item.vat_amount == null && item.vat_rate == null ? undefined
        : (item.vat_rate == null ? null : Number(item.vat_rate));
      const m = receiptMoney(item.unit_cost || 0, qty, vat);
      const { newOnHand, newAvg } = wac(product.on_hand, product.avg_cost, qty, m.grossUnit);
      if (!Number.isFinite(newOnHand)) throw new RpcError('Остаток вне допустимого диапазона.', 400);
      updateProduct.run(newOnHand, newAvg, product.id);
      insertMovement.run(product.id, qty, round2(m.grossUnit), poId, `PO ${po.po_number}`, user.id,
        po.supplier_id || null, batchNo, expiry, m.vatRate, m.vatAmount, m.net);
      bumpReceived.run(qty, item.id);
      if (po.supplier_id) {
        rememberSupplierPrice(db, {
          productId: product.id, supplierId: po.supplier_id, vat,
          price: item.unit_cost || 0, per: 1,   // цена заказа — за базовую единицу (ревью F2)
          packFactor: product.pack_factor, purchaseUnit: product.purchase_unit,
        });
      }
      received.push({ po_item_id: item.id, product_id: product.id, qty, on_hand: newOnHand, avg_cost: newAvg,
        vat_rate: m.vatRate, vat_amount: m.vatAmount });
    }

    // Fully received iff no line has any outstanding quantity left.
    const after = db.prepare('SELECT qty_ordered, qty_received FROM purchase_order_items WHERE po_id = ?').all(poId);
    const fully = after.every((it) => it.qty_received + 1e-9 >= it.qty_ordered);
    const status = fully ? 'received' : 'partial';
    if (fully) {
      db.prepare(`UPDATE purchase_orders SET status = 'received', received_at = ${NOW} WHERE id = ?`).run(poId);
    } else {
      db.prepare("UPDATE purchase_orders SET status = 'partial' WHERE id = ?").run(poId);
    }

    return { po_id: poId, status, received };
  });

  return run();
}

// -----------------------------------------------------------------------------
// SUPPLIERS_VAT_V1 (2026-09-28) — purchase_order_create: заказ на закупку со
// строками, ценой без НДС и ставкой НДС у каждой строки.
//
// Прежде экран писал заказ и его строки напрямую через /api/db, по одной
// строке, без проверки и без НДС. Теперь — одна транзакция здесь:
//   • цена строки — за БАЗОВУЮ единицу без НДС (как принимает заказ
//     receive_purchase_order); не прислана — из связи товара с поставщиком
//     заказа (цена связи — за единицу закупки, делится на упаковку), иначе 0,
//     как было;
//   • ставка — 12 %, 0 % или «без НДС» (null); не прислана — ставка связи,
//     иначе ставка товара;
//   • НДС строки = количество × цена × ставка / 100; сумма заказа — с НДС;
//   • номер PO-ГГГГММДД-NNN по дню клиники (как у заявок REQ-…).
// args: { supplier_id?, notes?, lines: [{ product_id, qty, unit_cost?, vat_rate? }] }
// -----------------------------------------------------------------------------
const MAX_PO_LINES = 500;
const MAX_PO_MONEY = 1e12;

export function purchaseOrderCreate(db, args, user) {
  requireCatalogEdit(db, user);
  const a = args || {};
  let supplierId = null;
  if (a.supplier_id !== undefined && a.supplier_id !== null && a.supplier_id !== '') {
    supplierId = Number(a.supplier_id);
    if (!isPositiveInt(supplierId)) throw new RpcError('Поставщик выбран неверно.', 400);
  }
  const notes = typeof a.notes === 'string' ? clean(a.notes).trim().slice(0, 500) : '';
  const rawLines = a.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw new RpcError('Добавьте хотя бы одну строку.', 400);
  if (rawLines.length > MAX_PO_LINES) throw rpcT(RpcError, 'Не больше {max} строк в одном заказе.', { max: MAX_PO_LINES }, 400);
  const lines = rawLines.map((l) => {
    if (!l || typeof l !== 'object') throw new RpcError('Строка заказа заполнена неверно.', 400);
    const productId = Number(l.product_id);
    if (!isPositiveInt(productId)) throw new RpcError('Товар не выбран.', 400);
    const qty = l.qty;
    if (!(typeof qty === 'number' && Number.isFinite(qty) && qty > 0 && qty <= MAX_QTY)) {
      throw rpcT(RpcError, 'Количество — положительное число, не больше {max}.', { max: MAX_QTY }, 400);
    }
    let unitCost;
    if (l.unit_cost !== undefined && l.unit_cost !== null && l.unit_cost !== '') {
      unitCost = Number(l.unit_cost);
      if (!(Number.isFinite(unitCost) && unitCost >= 0 && unitCost <= MAX_PO_MONEY)) throw new RpcError('Цена закупки — неотрицательное число.', 400);
    }
    return { productId, qty: roundQty(qty), unitCost, vat: readVat(l) };
  });

  const run = db.transaction(() => {
    if (supplierId && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) {
      throw new RpcError('Поставщик не найден.', 404);
    }
    const getProduct = db.prepare('SELECT id, name, pack_factor, vat_rate FROM products WHERE id = ?');
    const getLink = db.prepare('SELECT last_price, vat_rate, pack_factor FROM item_suppliers WHERE product_id = ? AND supplier_id = ?');
    const priced = lines.map((l) => {
      const product = getProduct.get(l.productId);
      if (!product) throw rpcT(RpcError, 'Товар №{id} не найден.', { id: l.productId }, 404);
      const link = supplierId ? getLink.get(l.productId, supplierId) : null;
      // Ревью F2 — цена связи за её СОБСТВЕННУЮ упаковку («кор = 100 таб»), а не
      // за упаковку товара: 9 000 за коробку → 90 за таблетку, а не 900.
      const linkPrice = linkPriceFor(link, product, 1);
      const unitCost = l.unitCost !== undefined ? l.unitCost : (linkPrice == null ? 0 : linkPrice);
      const vat = l.vat !== undefined ? l.vat
        : (link ? (link.vat_rate == null ? null : Number(link.vat_rate)) : (product.vat_rate == null ? null : Number(product.vat_rate)));
      const net = round2(l.qty * unitCost);
      const vatAmount = vatOnNet(net, vat);
      return { ...l, unitCost, vat, net, vatAmount };
    });
    const day = today(db).replace(/-/g, '');
    const prefix = `PO-${day}-`;
    const last = db.prepare('SELECT MAX(CAST(substr(po_number, ?) AS INTEGER)) AS n FROM purchase_orders WHERE po_number LIKE ?')
      .get(prefix.length + 1, `${prefix}%`).n;
    const poNumber = prefix + String((Number(last) || 0) + 1).padStart(3, '0');
    const net = round2(priced.reduce((s, l) => s + l.net, 0));
    const vat = round2(priced.reduce((s, l) => s + l.vatAmount, 0));
    const total = round2(net + vat);
    const poId = Number(db.prepare(`INSERT INTO purchase_orders (po_number, supplier_id, status, total, notes, created_by)
                                    VALUES (?, ?, 'draft', ?, ?, ?)`).run(poNumber, supplierId, total, notes || null, user.id).lastInsertRowid);
    const ins = db.prepare(`INSERT INTO purchase_order_items (po_id, product_id, qty_ordered, unit_cost, vat_rate, vat_amount)
                            VALUES (?, ?, ?, ?, ?, ?)`);
    for (const l of priced) ins.run(poId, l.productId, l.qty, l.unitCost, l.vat, l.vatAmount);
    return { po_id: poId, po_number: poNumber, net, vat, total };
  });
  return run();
}

// -----------------------------------------------------------------------------
// approve_requisition_and_issue — issue a department's requisition out of the
// single warehouse pool. args: { req_id }. Each line lowers on_hand (never
// below zero) and writes a 'dispense' movement (ref requisition/req_id) at the
// product's current average cost; avg_cost itself is unchanged by an issue.
// The requisition moves to 'issued'.
// -----------------------------------------------------------------------------
export function approveRequisitionAndIssue(db, args, user) {
  requireRole(user, PROCUREMENT_ROLES);

  const reqId = args && args.req_id;
  if (!isPositiveInt(reqId)) {
    throw new RpcError('Заявка не выбрана.', 400);
  }
  const REQ_STATUS_RU = { issued: 'уже выдана', rejected: 'отклонена', cancelled: 'отменена', converted: 'переведена в заказ' };

  const run = db.transaction(() => {
    const req = db.prepare('SELECT * FROM purchase_requisitions WHERE id = ?').get(reqId);
    if (!req) throw new RpcError('Заявка не найдена.', 400);
    if (!['draft', 'submitted', 'approved'].includes(req.status)) {
      throw new RpcError(`Заявку нельзя выдать: она ${REQ_STATUS_RU[req.status] || `в статусе «${req.status}»`}.`, 400);
    }

    const items = db.prepare('SELECT * FROM purchase_requisition_items WHERE req_id = ?').all(reqId);
    if (items.length === 0) throw new RpcError('В заявке нет строк.', 400);

    const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
    const updateProduct = db.prepare(`UPDATE products SET on_hand = ?, updated_at = ${NOW} WHERE id = ?`);
    // DEPARTMENTS_V1 — заявка от отдела выдаётся ЕМУ: движение помнит держателя,
    // остаток отдела растёт — та же передача, что у issue_stock_lines. Раньше
    // склад списывался, а отдел ничего не получал (вызов написан до миграции 128).
    // STOCK_REQUEST_V1 — выдаётся ДЕРЖАТЕЛЮ заявки (mig 145): сотруднику — ему на
    // руки, отделу — отделу. У заявки без держателя остаётся прежнее правило —
    // её отдел, а без отдела выдача остаётся списанием.
    const holder = req.holder_type
      ? resolveHolder(db, { type: req.holder_type, id: req.holder_id })
      : (req.department_id ? resolveHolder(db, { type: 'department', id: req.department_id }) : null);
    // Разбор ревью: отключённому сотруднику на руки не выдаём — товар повис бы
    // за человеком, который его уже не потратит и не вернёт.
    if (holder && holder.type === 'staff') {
      const u = db.prepare('SELECT is_active FROM users WHERE id = ?').get(holder.id);
      if (u && Number(u.is_active) === 0) {
        throw new RpcError(`${holder.name || 'Сотрудник'} отключён — выдать ему на руки нельзя. Отклоните заявку или выдайте отделу через «Выдать со склада».`, 400);
      }
    }
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, note, created_by, branch_id, holder_type, holder_id)
      VALUES (?, 'dispense', ?, ?, 'requisition', ?, ?, ?, 1, ?, ?)`);

    const issued = [];
    for (const it of items) {
      // STOCK_QTY_V1 (V3120_FIX) — ОДНО число на движение, склад и подотчёт.
      // Было: движение писало строку заявки как есть (-0.16666666666666666),
      // склад — round2 (0.17 ушло), подотчёт — round2 (0.17 пришло): три
      // разных «5 таблеток», и журнал не сходился с остатком.
      const product = getProduct.get(it.product_id);
      if (!product) throw new RpcError('Товар строки заявки не найден.', 400);
      const cf = factorOf(product);
      let qty = roundQty(it.qty);
      if (!(Number.isFinite(qty) && qty > 0 && qty <= MAX_QTY)) {
        throw new RpcError('В заявке строка с неверным количеством.', 400);
      }
      if (!coversQty(product.on_hand, qty, cf)) {
        throw rpcT(RpcError, 'Недостаточно на складе, чтобы выдать «{name}»: есть {have}, нужно {qty}.', { name: product.name, have: roundQty(product.on_hand), qty: `${qty} ${product.base_unit || ''}`.trim() }, 400);
      }
      qty = Math.min(qty, roundQty(product.on_hand));   // «последняя таблетка» в пределах допуска
      const newOnHand = settleQty(product.on_hand - qty, cf);
      updateProduct.run(newOnHand, product.id);
      insertMovement.run(product.id, -qty, round2(product.avg_cost || 0), reqId, `REQ ${req.req_number}`, user.id, holder ? holder.type : null, holder ? holder.id : null);
      if (holder) moveHolding(db, holder, product.id, qty);   // HOLDINGS_V1 — склад → отдел
      issued.push({ product_id: product.id, name: product.name, qty, on_hand: newOnHand });
    }

    db.prepare("UPDATE purchase_requisitions SET status = 'issued' WHERE id = ?").run(reqId);
    if (holder && holder.type === 'department') {
      logDepartmentEvent(db, holder.id, 'issued', user.id, {
        lines: issued.map((i) => ({ product_id: i.product_id, name: i.name, base_qty: i.qty })),
        note: `REQ ${req.req_number}`, req_id: reqId,
      });
    }
    return { req_id: reqId, status: 'issued', issued };
  });

  return run();
}

// -----------------------------------------------------------------------------
// post_stock_count — reconcile physical counts into on_hand. args: { count_id }.
// Lines left uncounted are ignored. The count moves to 'posted'.
//
// V3120_FIX — ПРОВОДИТСЯ РАСХОЖДЕНИЕ ЛИСТА, А НЕ «ОСТАТОК = ПОСЧИТАНО».
// Было: delta = counted − on_hand СЕЙЧАС. Лист снимает system_qty в момент
// создания, считают его часами, а клиника тем временем выдаёт: 2 шт, выданные
// пациенту между листом и проводкой, «воскресали» — остаток ставился равным
// посчитанному, будто их не выдавали. Стало: движение = variance строки листа
// (counted − system_qty, колонка миграции 028), и оно прибавляется к ЖИВОМУ
// остатку. Журнал равен листу, а выданное после листа остаётся выданным.
// Если товар двигался после листа, проводка не отказывает (пересчитывать
// заново весь склад из-за одного укола — хуже), но говорит об этом в ответе
// (warnings) и в основании движения. Уйти в минус проводка не может: такой
// лист отказывает целиком, называя товар.
// -----------------------------------------------------------------------------
export function postStockCount(db, args, user) {
  requireRole(user, PROCUREMENT_ROLES);

  const countId = args && args.count_id;
  if (!isPositiveInt(countId)) {
    throw new RpcError('Инвентаризация не выбрана.', 400);
  }

  const run = db.transaction(() => {
    const count = db.prepare('SELECT * FROM stock_counts WHERE id = ?').get(countId);
    if (!count) throw new RpcError('Инвентаризация не найдена.', 400);
    if (count.status === 'posted' || count.status === 'cancelled') {
      throw new RpcError(count.status === 'posted' ? 'Инвентаризация уже проведена.' : 'Инвентаризация отменена.', 400);
    }

    const items = db.prepare('SELECT * FROM stock_count_items WHERE count_id = ? AND counted_qty IS NOT NULL').all(countId);
    if (items.length === 0) throw new RpcError('В инвентаризации нет посчитанных строк.', 400);

    const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
    const updateProduct = db.prepare(`UPDATE products SET on_hand = ?, updated_at = ${NOW} WHERE id = ?`);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, note, created_by, branch_id)
      VALUES (?, 'adjust', ?, ?, 'stock_count', ?, ?, ?, 1)`);

    const adjustments = [];
    const warnings = [];
    for (const it of items) {
      const counted = it.counted_qty;
      if (!(typeof counted === 'number' && Number.isFinite(counted) && counted >= 0 && counted <= MAX_QTY)) {
        throw new RpcError('Посчитанное количество заполнено неверно.', 400);
      }
      const product = getProduct.get(it.product_id);
      if (!product) throw new RpcError('Товар строки инвентаризации не найден.', 400);
      const cf = factorOf(product);
      const unit = product.base_unit || product.unit || '';
      const systemQty = roundQty(it.system_qty || 0);
      const delta = roundQty(counted - systemQty);                  // расхождение ЛИСТА
      const moved = roundQty(product.on_hand - systemQty);          // что ушло/пришло после листа
      const next = settleQty(product.on_hand + delta, cf);
      if (next < 0) {
        throw new RpcError(`«${product.name}»: по листу ${roundQty(counted)} ${unit}, но после пересчёта ушло больше — `
          + `остаток стал бы ${next}. Пересчитайте этот товар заново.`.replace(/\s+/g, ' '), 400);
      }
      let note = `Инвентаризация ${count.count_number}`;
      if (Math.abs(moved) >= 1e-6) {
        const msg = `«${product.name}»: после пересчёта товар двигался (${moved > 0 ? '+' : ''}${moved} ${unit}`.replace(/\s+\)/, ')')
          + `) — проведено расхождение листа ${delta > 0 ? '+' : ''}${delta}, остаток ${next} ${unit}`.trim() + '.';
        warnings.push({ product_id: product.id, product_name: product.name, moved_since_count: moved, message: msg.replace(/\s+/g, ' ') });
        note += ` (после пересчёта движение ${moved > 0 ? '+' : ''}${moved})`;
      }
      if (delta !== 0) {
        updateProduct.run(next, product.id);
        insertMovement.run(product.id, delta, round2(product.avg_cost || 0), countId, note, user.id);
      }
      adjustments.push({ product_id: product.id, delta, on_hand: delta !== 0 ? next : roundQty(product.on_hand) });
    }

    db.prepare(`UPDATE stock_counts SET status = 'posted', posted_at = ${NOW} WHERE id = ?`).run(countId);
    return { count_id: countId, status: 'posted', adjustments, warnings };
  });

  return run();
}

export function adjustStock(db, args, user) {
  requireRole(user, PROCUREMENT_ROLES);

  const productId = args && args.product_id;
  if (!isPositiveInt(productId)) {
    throw new RpcError('Товар не выбран.', 400);
  }
  const qty = args && args.qty;
  if (!(typeof qty === 'number' && Number.isFinite(qty) && qty !== 0 && Math.abs(qty) <= MAX_QTY)) {
    throw new RpcError('Корректировка — ненулевое число.', 400);
  }
  const note = args && args.note;
  if (typeof note !== 'string' || note.trim() === '') {
    throw new RpcError('Для корректировки нужна причина.', 400);
  }

  const run = db.transaction(() => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) {
      throw new RpcError('Товар не найден.', 400);
    }

    const newOnHand = settleQty(product.on_hand + qty, factorOf(product));
    if (newOnHand < 0) {
      throw new RpcError('Корректировка увела бы остаток в минус.', 400);
    }

    db.prepare(`
      UPDATE products
      SET on_hand = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `).run(newOnHand, productId);

    db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, reference_type, note, created_by, branch_id)
      VALUES (?, 'adjust', ?, 'manual', ?, ?, 1)
    `).run(productId, roundQty(qty), note, user.id);

    return { product_id: productId, on_hand: newOnHand };
  });

  return run();
}

// =============================================================================
// PROCUREMENT_REDESIGN_V1 — Выдача (issue_stock_lines) + Excel-импорт товаров
// (import_products_excel), перенесены с ветки phase15-procurement.
// =============================================================================
const ISSUE_UNITS = ['base', 'consumption'];
// DEPARTMENTS_V1 — ключ квитанции: экран присылает случайную строку вместе с
// формой; повторная отправка той же формы (обновили страницу, нажали дважды)
// получает сохранённый ответ, а склад не списывается второй раз.
const IDEM_KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;
export function issueStockLines(db, args, user) {
  requireGrant(db, user, 'procurement.issue', 'edit', PROCUREMENT_ROLES, 'выдавать со склада');

  const idemKey = args && typeof args.idempotency_key === 'string' && IDEM_KEY_RE.test(args.idempotency_key) ? args.idempotency_key : null;
  if (idemKey) {
    const seen = db.prepare('SELECT result FROM stock_issue_receipts WHERE key = ?').get(idemKey);
    if (seen) { try { return { ...JSON.parse(seen.result), repeated: true }; } catch { /* испорченная квитанция — выдаём заново */ } }
  }

  // HOLDINGS_V1 — a structured recipient {type: staff|room|department, id}
  // makes the issue a MOVE: the holder's own ledger receives what the
  // warehouse gives up (rpc/holdings.js). The free-text recipient stays
  // accepted for the journal note and for older screens; without a holder
  // the issue is a plain write-off, as it always was.
  const holder = args && args.holder && typeof args.holder === 'object' ? resolveHolder(db, args.holder) : null;
  const recipient = (args && typeof args.recipient === 'string') ? args.recipient.trim() : (holder ? holder.name : '');
  if (!recipient) {
    throw new RpcError('Укажите получателя.', 400);
  }
  const extraNote = (args && typeof args.note === 'string') ? args.note.trim() : '';
  if (recipient.length > 200) {
    throw new RpcError('Получатель — не длиннее 200 символов.', 400);
  }
  if (extraNote.length > 500) {
    throw new RpcError('Примечание — не длиннее 500 символов.', 400);
  }

  const rawLines = args && args.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new RpcError('Добавьте хотя бы одну строку.', 400);
  }
  const lines = rawLines.map(line => {
    if (!line || typeof line !== 'object') {
      throw new RpcError('Строка выдачи заполнена неверно.', 400);
    }
    if (!isPositiveInt(line.product_id)) {
      throw new RpcError('Товар не выбран.', 400);
    }
    const qty = line.qty;
    if (!(typeof qty === 'number' && Number.isFinite(qty) && qty > 0 && qty <= MAX_QTY)) {
      throw rpcT(RpcError, 'Количество — положительное число, не больше {max}.', { max: MAX_QTY }, 400);
    }
    const unit = line.unit === undefined ? 'consumption' : line.unit;
    if (!ISSUE_UNITS.includes(unit)) {
      throw new RpcError('Единица: базовая или единица расхода.', 400);
    }
    return { productId: line.product_id, qty, unit };
  });

  const note = extraNote ? `${clean(recipient)} — ${clean(extraNote)}` : clean(recipient);

  const run = db.transaction(() => {
    // EXPIRY_BALANCE_V1 — партия смотрится ДО списания: предупредить надо о той,
    // которую со склада сейчас и возьмут, а не о той, что осталась после.
    // Предупреждение НИКОГДА не отменяет выдачу — владелец сказал
    // предупреждать, а не запрещать.
    const warnings = expiryWarnings(db, lines.map((l) => l.productId));

    const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
    const updateProduct = db.prepare(`
      UPDATE products
      SET on_hand = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, note, created_by, branch_id, holder_type, holder_id)
      VALUES (?, 'dispense', ?, ?, 'issue', ?, ?, 1, ?, ?)
    `);

    const issued = [];
    for (const { productId, qty, unit } of lines) {
      // Unlike dispenseItem, inactive products CAN be issued — residual stock
      // of a discontinued item still leaves the warehouse through «Выдать».
      const product = getProduct.get(productId);
      if (!product) {
        throw new RpcError('Товар не найден.', 400);
      }

      // STOCK_QTY_V1 (V3120_FIX) — было round2: 4 мл из литра (0.004 л)
      // округлялись в ноль и отказывали «qty is too small», 5 мл списывали 0.01 л.
      const cf = factorOf(product);
      let baseQty = unit === 'consumption' ? toBase(qty, cf) : roundQty(qty);
      if (!(baseQty > 0)) {
        throw new RpcError('Количество слишком мало для выдачи.', 400);
      }
      if (!coversQty(product.on_hand, baseQty, cf)) {
        throw rpcT(RpcError, 'Недостаточно остатка: {name} (в наличии {have})', { name: product.name, have: `${roundQty(product.on_hand)} ${product.base_unit || ''}`.trim() }, 400);
      }
      baseQty = Math.min(baseQty, roundQty(product.on_hand));

      const newOnHand = settleQty(product.on_hand - baseQty, cf);
      updateProduct.run(newOnHand, productId);
      insertMovement.run(productId, -baseQty, product.avg_cost, note, user.id, holder ? holder.type : null, holder ? holder.id : null);
      if (holder) moveHolding(db, holder, productId, baseQty);   // HOLDINGS_V1 — warehouse → holder
      issued.push({ product_id: productId, name: product.name, base_qty: baseQty, on_hand: newOnHand });
    }
    // DEPARTMENTS_V1 — журнал отдела: что выдано, сколько, кем.
    if (holder && holder.type === 'department') {
      logDepartmentEvent(db, holder.id, 'issued', user.id, {
        lines: issued.map((i) => ({ product_id: i.product_id, name: i.name, base_qty: i.base_qty })),
        note: extraNote || null,
      });
    }
    // Предупреждение лежит В КВИТАНЦИИ: повторная отправка той же формы обязана
    // вернуть тот же ответ целиком, а не «ничего страшного» вместо просрочки.
    const result = { issued, warnings };
    if (idemKey) db.prepare('INSERT INTO stock_issue_receipts (key, result) VALUES (?, ?)').run(idemKey, JSON.stringify(result));
    return result;
  });

  return run();
}

// -----------------------------------------------------------------------------
// DEPARTMENTS_V1 — create_requisition: заявка отдела на склад.
//
// Экран «Закупки → Новая заявка» звал этот вызов с облачных времён, а на
// офлайн-сервере его не было — кнопка отвечала «RPC not implemented». Теперь
// заявка создаётся здесь: номер REQ-ГГГГММДД-NNN, статус «submitted», строки в
// БАЗОВЫХ единицах (как и ждёт approve_requisition_and_issue).
// args: { p_department, p_notes?, p_lines: [{ item_id, qty, note? }] }
// Роли — как у таблицы в реестре: снабжение, администратор, врач, медсестра.
// -----------------------------------------------------------------------------
// STOCK_REQUEST_V1 — список ролей, разбор строк и сама запись заявки живут в
// rpc/stock-requests.js: заявку себе и автозаявку пишет то же ядро.
export function createRequisition(db, args, user) {
  requireRole(user, REQUISITION_ROLES);
  const a = args || {};
  const departmentId = Number(a.p_department);
  if (!isPositiveInt(departmentId)) throw new RpcError('Выберите отдел, для которого запрашиваются товары.', 400);
  const dept = db.prepare('SELECT id, name FROM departments WHERE id = ?').get(departmentId);
  if (!dept) throw new RpcError('Отдел не найден.', 404);
  const notes = typeof a.p_notes === 'string' ? a.p_notes.trim().slice(0, 500) : '';
  const lines = parseRequisitionLines(a.p_lines);

  const run = db.transaction(() => {
    for (const l of lines) {
      if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(l.productId)) throw new RpcError('Товар заявки не найден.', 404);
    }
    return insertRequisition(db, { holder: { type: 'department', id: departmentId }, notes, lines, userId: user.id });
  });
  return run();
}

// ---------------------------------------------------------------------------
// import_products_excel — «Импорт из Excel»: one transaction over template
// rows. Match by EXACT product name: update catalog fields, or create the
// product; a positive qty becomes a 'receive' movement with weighted-average
// costing (same math as receive_stock_lines). Unknown supplier names are
// created. Any invalid row aborts the whole batch, naming its Excel row
// (data row i -> Excel row i+2; row 1 is the template header).
//
// SUPPLIERS_VAT_V1 (2026-09-28) — владелец: «in the importing of the Excel we
// need to add an expiration date with a hardcoded format, so the user won't
// make mistakes», и типы товаров «жёстко». Новые колонки шаблона:
//   • «Категория» — одно из восьми названий (или ключ, goods-catalog.js). У
//     НОВОГО товара обязателен: прежде импорт молча заводил всё
//     «Расходниками», и лекарство уходило не в свою категорию;
//   • «НДС продажи» и «НДС прихода» — 12%, 0% или «без НДС» (ревью F3: была
//     одна колонка «НДС», и строка ПРИХОДА «без НДС» переписывала ставку
//     ПРОДАЖИ товара — а с ней, пока отчёты читали ставку карточки, и налог
//     всех прошлых месяцев). Теперь:
//       – «НДС продажи» — ставка товара (карточка): у нового товара — она, у
//         существующего — меняется только этой колонкой, пусто — не меняется;
//       – «НДС прихода» — ставка ЭТОГО прихода (и связи с поставщиком); ставку
//         продажи существующего товара она не трогает никогда, а новому
//         товару без «НДС продажи» даёт свою; пусто — НДС прихода «не
//         указан», как прежде; без «Кол-во» — отказ (не к чему относиться);
//       – прежний единый ключ vat_rate — отказ со словами о двух колонках;
//   • «Цена закупки без НДС» (прежнее «Себестоимость» — та же колонка): с
//     указанным НДС себестоимость на складе = цена × (1 + НДС), как у прихода;
//   • «Цена продажи»;
//   • «Партия» и «Срок годности (ДД.ММ.ГГГГ)» — у строки с количеством. Срок —
//     ОДИН формат: настоящую дату-ячейку Excel экран превращает в ДД.ММ.ГГГГ сам,
//     текст должен быть ровно ДД.ММ.ГГГГ. Другой формат, несуществующая дата и
//     прошедшая — отказ с номером строки (решение владельца: прошедшая —
//     отказ, а не предупреждение).
// Сообщения — шаблонами (rpcT): экран переводит их на язык интерфейса.
// ---------------------------------------------------------------------------
const MAX_IMPORT_ROWS = 2000;
const MAX_IMPORT_MONEY = 1e12;
// Ревью M5 — поля строки импорта, которые сервер знает (экран шлёт ровно их;
// vat_rate — прежняя единая колонка «НДС», на неё отказ словами о двух).
const IMPORT_FIELDS = new Set(['name', 'category', 'unit', 'qty', 'unit_cost', 'receipt_vat_rate', 'sale_price', 'sale_vat_rate',
  'vat_rate', 'reorder_level', 'supplier', 'batch_no', 'expiry_date']);

// Strip control characters before anything is stored — these strings are shown
// in the Журнал and exported to Excel.
function clean(s) {
  return s.replace(/[\x00-\x1F\x7F]+/g, ' ');
}

const MAX_NAME_LEN = 200;

function importStr(v) {
  return (v === undefined || v === null) ? '' : String(v).trim();
}

// SUPPLIERS_VAT_V1 — у денег свой потолок: цена закупки и продажи
// оборудования легко больше миллиона сумов, а потолок количества (MAX_QTY)
// отказывал таким строкам «должно быть числом от 0 до 1000000».
function importNum(v, label, rowNo, max = MAX_QTY) {
  if (v === undefined || v === null || v === '') return null;
  let n;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string') {
    // Excel cells arrive as text: allow a comma decimal and spacer whitespace,
    // but only a plain decimal number — never hex, exponent, or "1,2,3".
    const s = v.replace(/\s/g, '').replace(',', '.');
    n = /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  } else {
    n = NaN;
  }
  if (!Number.isFinite(n) || n < 0 || n > max) {
    throw rpcT(RpcError, 'Строка {row}: «{label}» должно быть числом от 0 до {max}.', { row: rowNo, label, max }, 400);
  }
  return n;
}

// Значение ячейки в сообщении — коротко: длинный мусор из чужой колонки не
// должен растягивать всплывающее окно на экран.
const cellText = (v) => String(v).trim().slice(0, 40);

export function importProductsExcel(db, args, user) {
  requireCatalogEdit(db, user);

  const rows = args && args.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new RpcError('В файле нет строк для импорта.', 400);
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw rpcT(RpcError, 'Не больше {max} строк за один импорт.', { max: MAX_IMPORT_ROWS }, 400);
  }
  // Сегодня — местный день сервера: срок годности раньше него — прошедший.
  const todayIso = db.prepare("SELECT date('now','localtime') AS d").get().d;

  const run = db.transaction(() => {
    const findSupplier = db.prepare('SELECT id FROM suppliers WHERE name = ?');
    const insertSupplier = db.prepare('INSERT INTO suppliers (name) VALUES (?)');
    const findProduct = db.prepare('SELECT * FROM products WHERE name = ?');
    const insertProduct = db.prepare(`
      INSERT INTO products (name, unit, base_unit, reorder_level, supplier_id, procurement_category, vat_rate, sale_price, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const updateCatalog = db.prepare(`
      UPDATE products
      SET base_unit = ?, unit = ?, reorder_level = ?, supplier_id = ?, procurement_category = ?, vat_rate = ?, sale_price = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `);
    const updateStock = db.prepare(`
      UPDATE products
      SET on_hand = ?, avg_cost = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, note, created_by, branch_id, supplier_id, batch_no, expiry_date, vat_rate, vat_amount, net_amount)
      VALUES (?, 'receive', ?, ?, 'import', 'Импорт из Excel', ?, 1, ?, ?, ?, ?, ?, ?)
    `);

    let created = 0, updated = 0, received = 0;
    rows.forEach((row, i) => {
      const rowNo = i + 2;
      if (!row || typeof row !== 'object') {
        throw rpcT(RpcError, 'Строка {row}: пустая строка.', { row: rowNo }, 400);
      }
      // Ревью M5 — строгий формат (владелец: «hardcoded format, so the user
      // won't make mistakes»): поле, которого импорт не знает, — отказ, а не
      // молча выброшенная колонка. Экран сам отказывает по незнакомому
      // заголовку; здесь — та же граница для любого другого вызова.
      for (const key of Object.keys(row)) {
        if (!IMPORT_FIELDS.has(key)) {
          throw rpcT(RpcError, 'Строка {row}: поле «{key}» импорт не знает — скачайте новый «Шаблон».', { row: rowNo, key: cellText(key) }, 400);
        }
      }
      const name = clean(importStr(row.name));
      if (!name) {
        throw rpcT(RpcError, 'Строка {row}: «Название» обязательно.', { row: rowNo }, 400);
      }
      if (name.length > MAX_NAME_LEN) {
        throw rpcT(RpcError, 'Строка {row}: «Название» длиннее {max} символов.', { row: rowNo, max: MAX_NAME_LEN }, 400);
      }
      const unit = clean(importStr(row.unit)).slice(0, 40);
      const supplierName = clean(importStr(row.supplier)).slice(0, MAX_NAME_LEN);
      const qty = importNum(row.qty, 'Кол-во', rowNo);
      const unitCost = importNum(row.unit_cost, 'Цена закупки без НДС', rowNo, MAX_IMPORT_MONEY);
      const reorder = importNum(row.reorder_level, 'Мин. остаток', rowNo);
      const salePrice = importNum(row.sale_price, 'Цена продажи', rowNo, MAX_IMPORT_MONEY);

      // Категория — только из восьми.
      const categoryText = importStr(row.category);
      let category = null;
      if (categoryText) {
        category = parseGoodsCategory(categoryText);
        if (!category) {
          throw rpcT(RpcError, 'Строка {row}: категория «{value}» — такой категории нет. Допустимо: {list}.',
            { row: rowNo, value: cellText(categoryText), list: GOODS_CATEGORY_LIST_RU }, 400);
        }
      }
      // Ревью F3 — две ставки вместо одной: продажи (товар) и прихода (строка).
      if (row.vat_rate !== undefined && row.vat_rate !== null && String(row.vat_rate).trim() !== '') {
        throw rpcT(RpcError, 'Строка {row}: колонка «НДС» теперь разделена — «НДС продажи» (ставка товара) и «НДС прихода» (ставка этого прихода). Скачайте новый «Шаблон».', { row: rowNo }, 400);
      }
      const vatOf = (v) => parseVatRate(typeof v === 'string' ? v.trim() : v);
      const saleVat = vatOf(row.sale_vat_rate);
      if (saleVat.error) {
        throw rpcT(RpcError, 'Строка {row}: НДС продажи «{value}» — допустимо 12%, 0% или «без НДС».', { row: rowNo, value: cellText(row.sale_vat_rate) }, 400);
      }
      const receiptVat = vatOf(row.receipt_vat_rate);
      if (receiptVat.error) {
        throw rpcT(RpcError, 'Строка {row}: НДС прихода «{value}» — допустимо 12%, 0% или «без НДС».', { row: rowNo, value: cellText(row.receipt_vat_rate) }, 400);
      }
      if (!receiptVat.empty && !(qty !== null && qty > 0)) {
        throw rpcT(RpcError, 'Строка {row}: «НДС прихода» относится к приходу — укажите «Кол-во».', { row: rowNo }, 400);
      }
      // Срок годности — ровно ДД.ММ.ГГГГ, настоящая дата, не прошедшая.
      // Число здесь — не дата: дату-ячейку экран уже превратил в ДД.ММ.ГГГГ.
      const exp = parseExpiryDmy(row.expiry_date, todayIso);
      if (exp.error === 'format') {
        throw rpcT(RpcError, 'Строка {row}: срок годности «{value}» — неверный формат. Нужен ДД.ММ.ГГГГ, например 31.12.2027.',
          { row: rowNo, value: cellText(row.expiry_date) }, 400);
      }
      if (exp.error === 'nodate') {
        throw rpcT(RpcError, 'Строка {row}: срок годности {value} — такой даты нет; формат ДД.ММ.ГГГГ.', { row: rowNo, value: cellText(row.expiry_date) }, 400);
      }
      if (exp.error === 'past') {
        throw rpcT(RpcError, 'Строка {row}: срок годности {value} уже прошёл — просроченный товар не принимается.', { row: rowNo, value: cellText(row.expiry_date) }, 400);
      }
      const batchNo = clean(importStr(row.batch_no)).slice(0, 80) || null;
      if ((exp.iso || batchNo) && !(qty !== null && qty > 0)) {
        throw rpcT(RpcError, 'Строка {row}: срок годности и партия относятся к приходу — укажите «Кол-во».', { row: rowNo }, 400);
      }

      let supplierId = null;
      if (supplierName) {
        const found = findSupplier.get(supplierName);
        supplierId = found ? found.id : Number(insertSupplier.run(supplierName).lastInsertRowid);
      }

      // An existing INACTIVE product matched by name is still updated and can
      // still receive stock — same deliberate choice as issueStockLines.
      const existing = findProduct.get(name);
      if (existing) {
        updateCatalog.run(
          unit || existing.base_unit,
          unit || existing.unit,
          reorder !== null ? reorder : existing.reorder_level,
          supplierId !== null ? supplierId : existing.supplier_id,
          category || existing.procurement_category,
          saleVat.empty ? existing.vat_rate : saleVat.rate,   // ставку продажи правит только «НДС продажи»
          salePrice !== null ? salePrice : existing.sale_price,
          existing.id,
        );
        updated++;
      } else {
        if (!category) {
          throw rpcT(RpcError, 'Строка {row}: у нового товара «{name}» укажите «Категорию» — одну из: {list}.',
            { row: rowNo, name: name.slice(0, 60), list: GOODS_CATEGORY_LIST_RU }, 400);
        }
        const u = unit || 'pcs';
        // Новый товар: ставка продажи — «НДС продажи», без неё — ставка прихода.
        const newVat = !saleVat.empty ? saleVat.rate : (!receiptVat.empty ? receiptVat.rate : null);
        insertProduct.run(name, u, u, reorder !== null ? reorder : 0, supplierId, category,
          newVat, salePrice !== null ? salePrice : 0);
        created++;
      }

      if (qty !== null && qty > 0) {
        const product = findProduct.get(name);   // fresh row after the catalog write
        const cost = unitCost !== null ? unitCost : 0;
        // НДС прихода — «НДС прихода» строки; без неё — «не указан».
        const vat = receiptVat.empty ? undefined : receiptVat.rate;
        const m = receiptMoney(cost, qty, vat);
        const costPerBase = round2(m.grossUnit);
        const newOnHand = roundQty(product.on_hand + qty);

        if (!Number.isFinite(newOnHand)) {
          throw rpcT(RpcError, 'Строка {row}: остаток вне диапазона.', { row: rowNo }, 400);
        }
        const newAvg = newOnHand > 0
          ? round2((product.avg_cost * product.on_hand + qty * costPerBase) / newOnHand)
          : product.avg_cost;
        updateStock.run(newOnHand, newAvg, product.id);
        insertMovement.run(product.id, qty, costPerBase, user.id, supplierId, batchNo, exp.iso || null, m.vatRate, m.vatAmount, m.net);
        received++;
      }
      // SUPPLIERS_VAT_V1 — поставщик строки связан с товаром (многие ко
      // многим); приход с ценой обновляет его цену и НДС, как «Принять товар».
      if (supplierId) {
        const product = findProduct.get(name);
        if (qty !== null && qty > 0 && unitCost !== null) {
          // Ревью F2 — цена импорта — за базовую единицу; связь помнит её в своей упаковке.
          rememberSupplierPrice(db, { productId: product.id, supplierId, vat: receiptVat.empty ? undefined : receiptVat.rate,
            price: unitCost, per: 1, packFactor: product.pack_factor, purchaseUnit: product.purchase_unit });
        } else {
          db.prepare(`INSERT OR IGNORE INTO item_suppliers (product_id, supplier_id, pack_factor, purchase_unit)
                      VALUES (?, ?, ?, ?)`).run(product.id, supplierId, product.pack_factor, product.purchase_unit);
        }
      }
    });

    return { created, updated, received };
  });

  return run();
}
