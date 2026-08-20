// Server-side procurement RPCs: unit-aware multi-line receiving with
// weighted-average costing (WAC), and manual stock adjustments. Both run
// inside db.transaction(...)() so a rejected line/adjustment leaves
// on_hand, avg_cost, and stock_movements completely untouched.
//
// Unit model: base_unit is the unit stock is held in. A receive line may be
// given in 'base' units or 'purchase' units (pack_factor base units per
// purchase unit). All stock quantities and the running average cost are
// always expressed in base units.

import { hasAnyRole } from '../roles.js';

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
    throw new RpcError('Your role is not allowed to perform this action.', 403);
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

function validateLine(line) {
  if (!line || typeof line !== 'object') {
    throw new RpcError('each line must be an object.', 400);
  }
  const productId = line.product_id;
  if (!isPositiveInt(productId)) {
    throw new RpcError('product_id must be a positive integer.', 400);
  }
  const qty = line.qty;
  if (!(typeof qty === 'number' && Number.isFinite(qty) && qty > 0 && qty <= MAX_QTY)) {
    throw new RpcError(`qty must be a positive number up to ${MAX_QTY}.`, 400);
  }
  const unit = line.unit === undefined ? 'base' : line.unit;
  if (!RECEIVE_UNITS.includes(unit)) {
    throw new RpcError(`unit must be one of ${RECEIVE_UNITS.join(', ')}.`, 400);
  }
  const unitCost = line.unit_cost === undefined ? 0 : line.unit_cost;
  if (!(typeof unitCost === 'number' && Number.isFinite(unitCost) && unitCost >= 0)) {
    throw new RpcError('unit_cost must be a non-negative number.', 400);
  }
  return { productId, qty, unit, unitCost };
}

export function receiveStockLines(db, args, user) {
  requireRole(user, PROCUREMENT_ROLES);

  const rawLines = args && args.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new RpcError('lines must be a non-empty array.', 400);
  }
  // RECEIVE_EASYMED_V1 — каждая строка может нести поставщика, партию/серию и
  // срок годности (mig 037); всё опционально и валидируется здесь.
  const lines = rawLines.map((l) => {
    const base = validateLine(l);
    let supplierId = null;
    if (l.supplier_id !== undefined && l.supplier_id !== null && l.supplier_id !== '') {
      if (!isPositiveInt(l.supplier_id)) throw new RpcError('supplier_id must be a positive integer.', 400);
      supplierId = l.supplier_id;
    }
    const batchNo = (typeof l.batch_no === 'string' ? l.batch_no.trim().slice(0, 80) : '') || null;
    let expiry = null;
    if (l.expiry_date !== undefined && l.expiry_date !== null && l.expiry_date !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(l.expiry_date))) throw new RpcError('expiry_date must be YYYY-MM-DD.', 400);
      expiry = String(l.expiry_date);
    }
    return { ...base, supplierId, batchNo, expiry };
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
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, note, created_by, branch_id, supplier_id, batch_no, expiry_date)
      VALUES (?, 'receive', ?, ?, 'manual', ?, ?, 1, ?, ?, ?)
    `);

    const received = [];
    for (const { productId, qty, unit, unitCost, supplierId, batchNo, expiry } of lines) {
      const product = getProduct.get(productId);
      if (!product) {
        throw new RpcError('product not found.', 400);
      }
      if (supplierId && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) {
        throw new RpcError('supplier not found.', 400);
      }

      const packFactor = product.pack_factor > 0 ? product.pack_factor : 1;
      const factor = unit === 'purchase' ? packFactor : 1;
      const baseQty = round2(qty * factor);
      const costPerBase = round2(factor > 0 ? unitCost / factor : unitCost);

      const oldOnHand = product.on_hand;
      const newOnHand = round2(oldOnHand + baseQty);
      if (!Number.isFinite(newOnHand)) {
        throw new RpcError('resulting stock is out of range.', 400);
      }
      const newAvg = newOnHand > 0
        ? round2((product.avg_cost * oldOnHand + baseQty * costPerBase) / newOnHand)
        : product.avg_cost;

      updateProduct.run(newOnHand, newAvg, productId);
      insertMovement.run(productId, baseQty, costPerBase, note, user.id, supplierId, batchNo, expiry);

      const fresh = getProduct.get(productId);
      received.push({ product_id: productId, base_qty: baseQty, on_hand: fresh.on_hand, avg_cost: fresh.avg_cost });
    }

    return { received };
  });

  return run();
}

// Weighted-average cost after adding `addQty` base units at `costPerUnit` each.
function wac(oldOnHand, oldAvg, addQty, costPerUnit) {
  const newOnHand = round2(oldOnHand + addQty);
  const newAvg = newOnHand > 0
    ? round2((oldAvg * oldOnHand + addQty * costPerUnit) / newOnHand)
    : oldAvg;
  return { newOnHand, newAvg };
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

// -----------------------------------------------------------------------------
// receive_purchase_order — book a delivery against a PO into the warehouse.
// args: { po_id, lines?: [{ po_item_id, qty }] }
//   • lines omitted  -> receive every line's full outstanding quantity
//   • lines provided -> receive exactly those base-unit quantities (partial OK)
// Each receipt raises on_hand + moving-average cost (WAC) at the line's
// unit_cost, writes a 'receive' stock_movement (ref purchase_order/po_id), and
// bumps po_item.qty_received. The PO becomes 'received' once every line is
// fully received, otherwise 'partial'. Cost is held in base units.
// -----------------------------------------------------------------------------
export function receivePurchaseOrder(db, args, user) {
  requireRole(user, PROCUREMENT_ROLES);

  const poId = args && args.po_id;
  if (!isPositiveInt(poId)) {
    throw new RpcError('po_id must be a positive integer.', 400);
  }
  const rawLines = args && args.lines;
  if (rawLines !== undefined && !Array.isArray(rawLines)) {
    throw new RpcError('lines must be an array when provided.', 400);
  }

  const run = db.transaction(() => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
    if (!po) throw new RpcError('purchase order not found.', 400);
    if (po.status === 'received' || po.status === 'cancelled') {
      throw new RpcError(`purchase order is already ${po.status}.`, 400);
    }

    const items = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(poId);
    if (items.length === 0) throw new RpcError('purchase order has no lines.', 400);
    const byId = new Map(items.map((it) => [it.id, it]));
    const outstanding = (it) => round2(it.qty_ordered - it.qty_received);

    // Resolve how much to receive per line.
    const plan = [];   // [{ item, qty }]
    if (Array.isArray(rawLines) && rawLines.length > 0) {
      for (const l of rawLines) {
        const it = byId.get(l && l.po_item_id);
        if (!it) throw new RpcError('po_item_id does not belong to this purchase order.', 400);
        const qty = l.qty;
        if (!(typeof qty === 'number' && Number.isFinite(qty) && qty > 0 && qty <= MAX_QTY)) {
          throw new RpcError(`qty must be a positive number up to ${MAX_QTY}.`, 400);
        }
        if (qty > outstanding(it) + 1e-9) {
          throw new RpcError('qty exceeds the outstanding amount for this line.', 400);
        }
        plan.push({ item: it, qty: round2(qty) });
      }
    } else {
      for (const it of items) {
        const out = outstanding(it);
        if (out > 0) plan.push({ item: it, qty: out });
      }
    }
    if (plan.length === 0) throw new RpcError('nothing to receive on this purchase order.', 400);

    const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
    const updateProduct = db.prepare(`UPDATE products SET on_hand = ?, avg_cost = ?, updated_at = ${NOW} WHERE id = ?`);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, note, created_by, branch_id)
      VALUES (?, 'receive', ?, ?, 'purchase_order', ?, ?, ?, 1)`);
    const bumpReceived = db.prepare('UPDATE purchase_order_items SET qty_received = round(qty_received + ?, 2) WHERE id = ?');

    const received = [];
    for (const { item, qty } of plan) {
      const product = getProduct.get(item.product_id);
      if (!product) throw new RpcError('product not found for a purchase-order line.', 400);
      const { newOnHand, newAvg } = wac(product.on_hand, product.avg_cost, qty, item.unit_cost || 0);
      if (!Number.isFinite(newOnHand)) throw new RpcError('resulting stock is out of range.', 400);
      updateProduct.run(newOnHand, newAvg, product.id);
      insertMovement.run(product.id, qty, round2(item.unit_cost || 0), poId, `PO ${po.po_number}`, user.id);
      bumpReceived.run(qty, item.id);
      received.push({ po_item_id: item.id, product_id: product.id, qty, on_hand: newOnHand, avg_cost: newAvg });
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
    throw new RpcError('req_id must be a positive integer.', 400);
  }

  const run = db.transaction(() => {
    const req = db.prepare('SELECT * FROM purchase_requisitions WHERE id = ?').get(reqId);
    if (!req) throw new RpcError('requisition not found.', 400);
    if (!['draft', 'submitted', 'approved'].includes(req.status)) {
      throw new RpcError(`requisition cannot be issued (status ${req.status}).`, 400);
    }

    const items = db.prepare('SELECT * FROM purchase_requisition_items WHERE req_id = ?').all(reqId);
    if (items.length === 0) throw new RpcError('requisition has no items.', 400);

    const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
    const updateProduct = db.prepare(`UPDATE products SET on_hand = ?, updated_at = ${NOW} WHERE id = ?`);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, note, created_by, branch_id)
      VALUES (?, 'dispense', ?, ?, 'requisition', ?, ?, ?, 1)`);

    const issued = [];
    for (const it of items) {
      const qty = it.qty;
      if (!(typeof qty === 'number' && Number.isFinite(qty) && qty > 0 && qty <= MAX_QTY)) {
        throw new RpcError('a requisition line has an invalid quantity.', 400);
      }
      const product = getProduct.get(it.product_id);
      if (!product) throw new RpcError('product not found for a requisition line.', 400);
      const newOnHand = round2(product.on_hand - qty);
      if (newOnHand < 0) {
        throw new RpcError(`insufficient stock to issue ${product.name} (have ${product.on_hand}, need ${qty}).`, 400);
      }
      updateProduct.run(newOnHand, product.id);
      insertMovement.run(product.id, -qty, round2(product.avg_cost || 0), reqId, `REQ ${req.req_number}`, user.id);
      issued.push({ product_id: product.id, qty, on_hand: newOnHand });
    }

    db.prepare("UPDATE purchase_requisitions SET status = 'issued' WHERE id = ?").run(reqId);
    return { req_id: reqId, status: 'issued', issued };
  });

  return run();
}

// -----------------------------------------------------------------------------
// post_stock_count — reconcile physical counts into on_hand. args: { count_id }.
// For each counted line (counted_qty not null) the physical count is treated as
// truth: on_hand is set to counted_qty and the signed delta (counted - current)
// is written as an 'adjust' movement (ref stock_count/count_id). Lines left
// uncounted are ignored. The count moves to 'posted'.
// -----------------------------------------------------------------------------
export function postStockCount(db, args, user) {
  requireRole(user, PROCUREMENT_ROLES);

  const countId = args && args.count_id;
  if (!isPositiveInt(countId)) {
    throw new RpcError('count_id must be a positive integer.', 400);
  }

  const run = db.transaction(() => {
    const count = db.prepare('SELECT * FROM stock_counts WHERE id = ?').get(countId);
    if (!count) throw new RpcError('stock count not found.', 400);
    if (count.status === 'posted' || count.status === 'cancelled') {
      throw new RpcError(`stock count is already ${count.status}.`, 400);
    }

    const items = db.prepare('SELECT * FROM stock_count_items WHERE count_id = ? AND counted_qty IS NOT NULL').all(countId);
    if (items.length === 0) throw new RpcError('stock count has no counted lines to post.', 400);

    const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
    const updateProduct = db.prepare(`UPDATE products SET on_hand = ?, updated_at = ${NOW} WHERE id = ?`);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, note, created_by, branch_id)
      VALUES (?, 'adjust', ?, ?, 'stock_count', ?, ?, ?, 1)`);

    const adjustments = [];
    for (const it of items) {
      const counted = it.counted_qty;
      if (!(typeof counted === 'number' && Number.isFinite(counted) && counted >= 0 && counted <= MAX_QTY)) {
        throw new RpcError('a counted quantity is invalid.', 400);
      }
      const product = getProduct.get(it.product_id);
      if (!product) throw new RpcError('product not found for a stock-count line.', 400);
      const delta = round2(counted - product.on_hand);
      if (delta !== 0) {
        updateProduct.run(round2(counted), product.id);
        insertMovement.run(product.id, delta, round2(product.avg_cost || 0), countId, `Count ${count.count_number}`, user.id);
      }
      adjustments.push({ product_id: product.id, delta, on_hand: round2(counted) });
    }

    db.prepare(`UPDATE stock_counts SET status = 'posted', posted_at = ${NOW} WHERE id = ?`).run(countId);
    return { count_id: countId, status: 'posted', adjustments };
  });

  return run();
}

export function adjustStock(db, args, user) {
  requireRole(user, PROCUREMENT_ROLES);

  const productId = args && args.product_id;
  if (!isPositiveInt(productId)) {
    throw new RpcError('product_id must be a positive integer.', 400);
  }
  const qty = args && args.qty;
  if (!(typeof qty === 'number' && Number.isFinite(qty) && qty !== 0)) {
    throw new RpcError('qty must be a non-zero finite number.', 400);
  }
  const note = args && args.note;
  if (typeof note !== 'string' || note.trim() === '') {
    throw new RpcError('a note is required for adjustments.', 400);
  }

  const run = db.transaction(() => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) {
      throw new RpcError('product not found.', 400);
    }

    const newOnHand = round2(product.on_hand + qty);
    if (newOnHand < 0) {
      throw new RpcError('adjustment would make stock negative.', 400);
    }

    db.prepare(`
      UPDATE products
      SET on_hand = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `).run(newOnHand, productId);

    db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, reference_type, note, created_by, branch_id)
      VALUES (?, 'adjust', ?, 'manual', ?, ?, 1)
    `).run(productId, qty, note, user.id);

    return { product_id: productId, on_hand: newOnHand };
  });

  return run();
}

// =============================================================================
// PROCUREMENT_REDESIGN_V1 — Выдача (issue_stock_lines) + Excel-импорт товаров
// (import_products_excel), перенесены с ветки phase15-procurement.
// =============================================================================
const ISSUE_UNITS = ['base', 'consumption'];
export function issueStockLines(db, args, user) {
  requireRole(user, PROCUREMENT_ROLES);

  const recipient = (args && typeof args.recipient === 'string') ? args.recipient.trim() : '';
  if (!recipient) {
    throw new RpcError('recipient is required.', 400);
  }
  const extraNote = (args && typeof args.note === 'string') ? args.note.trim() : '';
  if (recipient.length > 200) {
    throw new RpcError('recipient is too long (max 200 chars).', 400);
  }
  if (extraNote.length > 500) {
    throw new RpcError('note is too long (max 500 chars).', 400);
  }

  const rawLines = args && args.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new RpcError('lines must be a non-empty array.', 400);
  }
  const lines = rawLines.map(line => {
    if (!line || typeof line !== 'object') {
      throw new RpcError('each line must be an object.', 400);
    }
    if (!isPositiveInt(line.product_id)) {
      throw new RpcError('product_id must be a positive integer.', 400);
    }
    const qty = line.qty;
    if (!(typeof qty === 'number' && Number.isFinite(qty) && qty > 0 && qty <= MAX_QTY)) {
      throw new RpcError(`qty must be a positive number up to ${MAX_QTY}.`, 400);
    }
    const unit = line.unit === undefined ? 'consumption' : line.unit;
    if (!ISSUE_UNITS.includes(unit)) {
      throw new RpcError(`unit must be one of ${ISSUE_UNITS.join(', ')}.`, 400);
    }
    return { productId: line.product_id, qty, unit };
  });

  const note = extraNote ? `${clean(recipient)} — ${clean(extraNote)}` : clean(recipient);

  const run = db.transaction(() => {
    const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
    const updateProduct = db.prepare(`
      UPDATE products
      SET on_hand = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, note, created_by, branch_id)
      VALUES (?, 'dispense', ?, ?, 'issue', ?, ?, 1)
    `);

    const issued = [];
    for (const { productId, qty, unit } of lines) {
      // Unlike dispenseItem, inactive products CAN be issued — residual stock
      // of a discontinued item still leaves the warehouse through «Выдать».
      const product = getProduct.get(productId);
      if (!product) {
        throw new RpcError('product not found.', 400);
      }

      const cf = (product.consumption_unit && product.consumption_factor > 0) ? product.consumption_factor : 1;
      const baseQty = round2(unit === 'consumption' ? qty / cf : qty);
      if (!(baseQty > 0)) {
        throw new RpcError('qty is too small to issue.', 400);
      }
      if (product.on_hand < baseQty) {
        throw new RpcError(
          `Недостаточно остатка: ${product.name} (в наличии ${round2(product.on_hand)} ${product.base_unit || ''})`.trim(), 400);
      }

      const newOnHand = round2(product.on_hand - baseQty);
      updateProduct.run(newOnHand, productId);
      insertMovement.run(productId, -baseQty, product.avg_cost, note, user.id);
      issued.push({ product_id: productId, base_qty: baseQty, on_hand: newOnHand });
    }
    return { issued };
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
// ---------------------------------------------------------------------------
const MAX_IMPORT_ROWS = 2000;

// Strip control characters before anything is stored — these strings are shown
// in the Журнал and exported to Excel.
function clean(s) {
  return s.replace(/[\x00-\x1F\x7F]+/g, ' ');
}

const MAX_NAME_LEN = 200;

function importStr(v) {
  return (v === undefined || v === null) ? '' : String(v).trim();
}

function importNum(v, label, rowNo) {
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
  if (!Number.isFinite(n) || n < 0 || n > MAX_QTY) {
    throw new RpcError(`Строка ${rowNo}: «${label}» должно быть числом от 0 до ${MAX_QTY}.`, 400);
  }
  return n;
}

export function importProductsExcel(db, args, user) {
  requireRole(user, PROCUREMENT_ROLES);

  const rows = args && args.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new RpcError('rows must be a non-empty array.', 400);
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new RpcError(`Не больше ${MAX_IMPORT_ROWS} строк за один импорт.`, 400);
  }

  const run = db.transaction(() => {
    const findSupplier = db.prepare('SELECT id FROM suppliers WHERE name = ?');
    const insertSupplier = db.prepare('INSERT INTO suppliers (name) VALUES (?)');
    const findProduct = db.prepare('SELECT * FROM products WHERE name = ?');
    const insertProduct = db.prepare(`
      INSERT INTO products (name, unit, base_unit, reorder_level, supplier_id, procurement_category, active)
      VALUES (?, ?, ?, ?, ?, 'consumables', 1)
    `);
    const updateCatalog = db.prepare(`
      UPDATE products
      SET base_unit = ?, unit = ?, reorder_level = ?, supplier_id = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `);
    const updateStock = db.prepare(`
      UPDATE products
      SET on_hand = ?, avg_cost = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, note, created_by, branch_id)
      VALUES (?, 'receive', ?, ?, 'import', 'Импорт из Excel', ?, 1)
    `);

    let created = 0, updated = 0, received = 0;
    rows.forEach((row, i) => {
      const rowNo = i + 2;
      if (!row || typeof row !== 'object') {
        throw new RpcError(`Строка ${rowNo}: пустая строка.`, 400);
      }
      const name = clean(importStr(row.name));
      if (!name) {
        throw new RpcError(`Строка ${rowNo}: «Название» обязательно.`, 400);
      }
      if (name.length > MAX_NAME_LEN) {
        throw new RpcError(`Строка ${rowNo}: «Название» длиннее ${MAX_NAME_LEN} символов.`, 400);
      }
      const unit = clean(importStr(row.unit)).slice(0, 40);
      const supplierName = clean(importStr(row.supplier)).slice(0, MAX_NAME_LEN);
      const qty = importNum(row.qty, 'Кол-во', rowNo);
      const unitCost = importNum(row.unit_cost, 'Себестоимость', rowNo);
      const reorder = importNum(row.reorder_level, 'Мин. остаток', rowNo);

      let supplierId = null;
      if (supplierName) {
        const found = findSupplier.get(supplierName);
        supplierId = found ? found.id : insertSupplier.run(supplierName).lastInsertRowid;
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
          existing.id,
        );
        updated++;
      } else {
        const u = unit || 'pcs';
        insertProduct.run(name, u, u, reorder !== null ? reorder : 0, supplierId);
        created++;
      }

      if (qty !== null && qty > 0) {
        const product = findProduct.get(name);   // fresh row after the catalog write
        const cost = unitCost !== null ? unitCost : 0;
        const newOnHand = round2(product.on_hand + qty);
        if (!Number.isFinite(newOnHand)) {
          throw new RpcError(`Строка ${rowNo}: остаток вне диапазона.`, 400);
        }
        const newAvg = newOnHand > 0
          ? round2((product.avg_cost * product.on_hand + qty * cost) / newOnHand)
          : product.avg_cost;
        updateStock.run(newOnHand, newAvg, product.id);
        insertMovement.run(product.id, qty, cost, user.id);
        received++;
      }
    });

    return { created, updated, received };
  });

  return run();
}
