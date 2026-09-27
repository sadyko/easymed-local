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
    throw new RpcError(`Количество — положительное число, не больше ${MAX_QTY}.`, 400);
  }
  const unit = line.unit === undefined ? 'base' : line.unit;
  if (!RECEIVE_UNITS.includes(unit)) {
    throw new RpcError('Единица: базовая или единица закупки.', 400);
  }
  const unitCost = line.unit_cost === undefined ? 0 : line.unit_cost;
  if (!(typeof unitCost === 'number' && Number.isFinite(unitCost) && unitCost >= 0)) {
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

export function receiveStockLines(db, args, user) {
  requireRole(user, PROCUREMENT_ROLES);

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
    return { ...base, supplierId, batchNo: readBatch(l), expiry: readExpiry(l) };
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
        throw new RpcError('Товар не найден.', 400);
      }
      if (supplierId && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) {
        throw new RpcError('Поставщик не найден.', 400);
      }

      const packFactor = product.pack_factor > 0 ? product.pack_factor : 1;
      const factor = unit === 'purchase' ? packFactor : 1;
      const baseQty = roundQty(qty * factor);
      const costPerBase = round2(factor > 0 ? unitCost / factor : unitCost);

      const oldOnHand = product.on_hand;
      const newOnHand = settleQty(oldOnHand + baseQty, factorOf(product));
      if (!Number.isFinite(newOnHand)) {
        throw new RpcError('Остаток вне допустимого диапазона.', 400);
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
// -----------------------------------------------------------------------------
export function receivePurchaseOrder(db, args, user) {
  requireRole(user, PROCUREMENT_ROLES);

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
          throw new RpcError(`Количество — положительное число, не больше ${MAX_QTY}.`, 400);
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
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, note, created_by, branch_id, supplier_id, batch_no, expiry_date)
      VALUES (?, 'receive', ?, ?, 'purchase_order', ?, ?, ?, 1, ?, ?, ?)`);
    const bumpReceived = db.prepare('UPDATE purchase_order_items SET qty_received = round(qty_received + ?, 6) WHERE id = ?');

    const received = [];
    for (const { item, qty, batchNo, expiry } of plan) {
      const product = getProduct.get(item.product_id);
      if (!product) throw new RpcError('Товар строки заказа не найден.', 400);
      const { newOnHand, newAvg } = wac(product.on_hand, product.avg_cost, qty, item.unit_cost || 0);
      if (!Number.isFinite(newOnHand)) throw new RpcError('Остаток вне допустимого диапазона.', 400);
      updateProduct.run(newOnHand, newAvg, product.id);
      insertMovement.run(product.id, qty, round2(item.unit_cost || 0), poId, `PO ${po.po_number}`, user.id,
        po.supplier_id || null, batchNo, expiry);
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
        throw new RpcError(`Недостаточно на складе, чтобы выдать «${product.name}»: есть ${roundQty(product.on_hand)}, нужно ${qty} ${product.base_unit || ''}`.trim() + '.', 400);
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
      throw new RpcError(`Количество — положительное число, не больше ${MAX_QTY}.`, 400);
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
        throw new RpcError(
          `Недостаточно остатка: ${product.name} (в наличии ${roundQty(product.on_hand)} ${product.base_unit || ''})`.trim(), 400);
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
    throw new RpcError('В файле нет строк для импорта.', 400);
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
        const newOnHand = roundQty(product.on_hand + qty);

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
