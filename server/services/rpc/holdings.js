// HOLDINGS_V1 — what a nurse, a cabinet or a department holds after the
// warehouse issued it, and how it reaches the patient (migration 128).
//
// Owner (2026-09-14): «nurses can dispense items which is dispensed from the
// procurement either to the nurse or either to the cabinet or to the
// department. please inspect that flow too, so it will work seamlessly».
//
// The flow it repairs: «Выдать со склада» deducted products.on_hand and wrote
// the recipient as free text; the nurse's later dispense to a patient deducted
// on_hand AGAIN. Now an issue MOVES stock (warehouse → holder), and a dispense
// from a holding takes it from the holder only. See the migration header.
//
// Quantities on the ledger are BASE units (like products.on_hand). The nurse
// types the CONSUMPTION unit («2 таб.»); the conversion is the product's own
// consumption_factor, exactly as «Выдать со склада» converts on the way in.
import { hasAnyRole } from '../roles.js';
import { assertAdmissionAtLeast } from './inpatient-flow.js';
import { today, localDate } from '../domain/day.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export const HOLDER_TYPES = ['staff', 'room', 'department'];
// The warehouse itself is also a valid SOURCE for a dispense (not a holder):
// a nurse with nothing issued to her can still give from the general stock —
// the old dispense_item behaviour, kept under one door (owner 2026-09-14:
// «i cannot dispense items to the patients in the ambulatory»).
export const WAREHOUSE = 'warehouse';
const LIST_ROLES = ['admin', 'inventory', 'nurse', 'doctor', 'registrar', 'cashier'];
const DISPENSE_ROLES = ['admin', 'inventory', 'nurse', 'doctor'];
const MAX_QTY = 1_000_000;

function requireRole(user, allowed) {
  if (!hasAnyRole(user, allowed)) throw new RpcError('Ваша роль не может выполнить это действие.', 403);
}
const round2 = (n) => Math.round(n * 100) / 100;
const isPosInt = (v) => Number.isInteger(v) && v > 0;

/** The holder named by args, validated against the tables it points at. */
export function resolveHolder(db, holder) {
  const type = holder && typeof holder.type === 'string' ? holder.type : '';
  const id = holder ? Number(holder.id) : NaN;
  if (!HOLDER_TYPES.includes(type)) throw new RpcError('Получатель: укажите сотрудника, кабинет или отделение.', 400);
  if (!isPosInt(id)) throw new RpcError('Получатель не выбран.', 400);
  const table = type === 'staff' ? 'users' : type === 'room' ? 'rooms' : 'departments';
  const nameCol = type === 'staff' ? 'full_name' : 'name';
  const row = db.prepare(`SELECT id, ${nameCol} AS name FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new RpcError('Получатель не найден.', 404);
  return { type, id, name: row.name || '' };
}

/** Consumption-unit factor of a product (1 when it has none). */
export function consumptionFactor(product) {
  return product && product.consumption_unit && Number(product.consumption_factor) > 0 ? Number(product.consumption_factor) : 1;
}

/** Add `baseQty` (may be negative) to a holder's line; refuses to go below zero. */
export function moveHolding(db, holder, productId, baseQty) {
  const row = db.prepare('SELECT id, qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?')
    .get(holder.type, holder.id, productId);
  const next = round2((row ? row.qty : 0) + baseQty);
  if (next < -1e-9) {
    throw new RpcError('Недостаточно на руках: у получателя меньше, чем выдаётся.', 400);
  }
  if (row) {
    db.prepare("UPDATE stock_holdings SET qty = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(next, row.id);
  } else {
    db.prepare('INSERT INTO stock_holdings (holder_type, holder_id, product_id, qty) VALUES (?, ?, ?, ?)').run(holder.type, holder.id, productId, next);
  }
  return next;
}

/**
 * holdings_list — what holders have on hand.
 * args: { holder_type?, holder_id?, include_empty? }  (no holder → every holder)
 * → { holdings: [{ holder_type, holder_id, holder_name, product_id, product_name,
 *      base_unit, consumption_unit, consumption_factor, sale_price, qty_base, qty_units }] }
 * qty_units = qty in the consumption unit — what the nurse counts in.
 */
export function holdingsList(db, args, user) {
  requireRole(user, LIST_ROLES);
  const a = args || {};
  const where = ['1=1'];
  const params = [];
  if (a.holder_type) {
    if (!HOLDER_TYPES.includes(a.holder_type)) throw new RpcError('holder_type неизвестен.', 400);
    where.push('h.holder_type = ?'); params.push(a.holder_type);
  }
  if (a.holder_id != null) { where.push('h.holder_id = ?'); params.push(Number(a.holder_id)); }
  if (!a.include_empty) where.push('h.qty > 0');
  const rows = db.prepare(`
    SELECT h.holder_type, h.holder_id, h.product_id, h.qty,
           p.name AS product_name, p.base_unit, p.consumption_unit, p.consumption_factor, p.sale_price, p.is_drug, p.active,
           CASE h.holder_type
             WHEN 'staff' THEN (SELECT full_name FROM users WHERE id = h.holder_id)
             WHEN 'room' THEN (SELECT name FROM rooms WHERE id = h.holder_id)
             ELSE (SELECT name FROM departments WHERE id = h.holder_id) END AS holder_name
      FROM stock_holdings h
      JOIN products p ON p.id = h.product_id
     WHERE ${where.join(' AND ')}
     ORDER BY h.holder_type, holder_name, p.name`).all(...params);
  return {
    holdings: rows.map((r) => {
      const cf = consumptionFactor(r);
      return {
        holder_type: r.holder_type, holder_id: r.holder_id, holder_name: r.holder_name || '',
        product_id: r.product_id, product_name: r.product_name,
        base_unit: r.base_unit || '', consumption_unit: r.consumption_unit || r.base_unit || '', consumption_factor: cf,
        sale_price: Number(r.sale_price) || 0, is_drug: !!r.is_drug, active: !!r.active,
        qty_base: round2(r.qty), qty_units: round2(r.qty * cf),
      };
    }),
  };
}

/**
 * dispense_from_holding — a nurse gives a patient something she (her cabinet,
 * her department) holds. Takes it from the holding; the warehouse is untouched
 * (it was deducted when the item was issued). Bills the visit or the
 * admission like the warehouse dispenses do, at the sale price per
 * consumption unit.
 * args: { holder:{type,id}, product_id, quantity (consumption units), visit_id? | admission_id?,
 *         billable? (default true), note? }
 */
export function dispenseFromHolding(db, args, user) {
  requireRole(user, DISPENSE_ROLES);
  const a = args || {};
  const productId = a.product_id;
  if (!isPosInt(productId)) throw new RpcError('product_id must be a positive integer.', 400);
  const qtyUnits = a.quantity;
  if (!(typeof qtyUnits === 'number' && Number.isFinite(qtyUnits) && qtyUnits > 0 && qtyUnits <= MAX_QTY)) {
    throw new RpcError('Количество — положительное число.', 400);
  }
  const visitId = a.visit_id == null ? null : Number(a.visit_id);
  const admissionId = a.admission_id == null ? null : Number(a.admission_id);
  if ((visitId && admissionId) || (!visitId && !admissionId)) throw new RpcError('Укажите визит или госпитализацию — одно из двух.', 400);
  const billable = a.billable === undefined ? true : !!a.billable;
  const note = typeof a.note === 'string' ? a.note.trim().slice(0, 300) : '';

  const run = db.transaction(() => {
    const fromWarehouse = !!(a.holder && a.holder.type === WAREHOUSE);
    const holder = fromWarehouse ? null : resolveHolder(db, a.holder);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new RpcError('Товар не найден.', 400);
    const cf = consumptionFactor(product);
    const baseQty = round2(qtyUnits / cf);
    if (!(baseQty > 0)) throw new RpcError('Количество слишком мало.', 400);
    if (fromWarehouse) {
      if (!product.active) throw new RpcError('Товар отключён в каталоге.', 400);
      if (product.on_hand + 1e-9 < baseQty) {
        throw new RpcError(`Недостаточно на складе: ${product.name} — есть ${round2(product.on_hand * cf)} ${product.consumption_unit || product.base_unit || ''}`.trim(), 400);
      }
      db.prepare("UPDATE products SET on_hand = on_hand - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(baseQty, productId);
    } else {
      const held = db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(holder.type, holder.id, productId);
      if (!held || held.qty + 1e-9 < baseQty) {
        const have = held ? round2(held.qty * cf) : 0;
        throw new RpcError(`Недостаточно на руках: ${product.name} — есть ${have} ${product.consumption_unit || product.base_unit || ''}`.trim(), 400);
      }
      moveHolding(db, holder, productId, -baseQty);
    }

    // Price per consumption unit — the sale price is per base unit.
    const unitPrice = round2(Number(product.sale_price) / cf);
    const total = round2(unitPrice * qtyUnits);
    let lineId = null;
    let refType = 'visit';
    if (visitId) {
      const visit = db.prepare('SELECT id FROM visits WHERE id = ?').get(visitId);
      if (!visit) throw new RpcError('Визит не найден.', 400);
      lineId = db.prepare(`
        INSERT INTO visit_services (visit_id, clinic_item_id, service_id, doctor_id, quantity, unit_price, total, status, created_by)
        VALUES (?, ?, NULL, NULL, ?, ?, ?, 'added', ?)`).run(visitId, productId, qtyUnits, billable ? unitPrice : 0, billable ? total : 0, user.id).lastInsertRowid;
    } else {
      const adm = assertAdmissionAtLeast(db, admissionId, 'active');
      refType = 'admission';
      lineId = db.prepare(`
        INSERT INTO admission_services (admission_id, clinic_item_id, service_id, doctor_id, bed_id, ward_id, quantity, unit_price, total, status, billable, notes, performed_at)
        VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'added', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
        .run(admissionId, productId, adm.bed_id, adm.ward_id, qtyUnits, unitPrice, total, billable ? 1 : 0, note || null).lastInsertRowid;
    }
    db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, note, created_by, holder_type, holder_id)
      VALUES (?, 'dispense', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(productId, -baseQty, product.avg_cost, refType, lineId, note, user.id, holder ? holder.type : null, holder ? holder.id : null);
    let leftBase = 0;
    if (holder) {
      const left = db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(holder.type, holder.id, productId);
      leftBase = left ? left.qty : 0;
    } else {
      leftBase = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(productId).on_hand;
    }
    return { line_id: lineId, item_name: product.name, unit_price: unitPrice, total, left_units: round2(leftBase * cf), source: holder ? holder.type : WAREHOUSE };
  });
  return run();
}

/**
 * void_holding_dispense — undo a not-yet-invoiced dispense: the line is removed
 * and the quantity goes back to the holder it came from (found by the
 * movement that recorded it).
 * args: { visit_service_id? | admission_service_id? }
 */
export function voidHoldingDispense(db, args, user) {
  requireRole(user, DISPENSE_ROLES);
  const a = args || {};
  const vsId = a.visit_service_id == null ? null : Number(a.visit_service_id);
  const asId = a.admission_service_id == null ? null : Number(a.admission_service_id);
  if (!vsId && !asId) throw new RpcError('Укажите строку.', 400);
  const run = db.transaction(() => {
    const table = vsId ? 'visit_services' : 'admission_services';
    const refType = vsId ? 'visit' : 'admission';
    const id = vsId || asId;
    const line = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!line) throw new RpcError('Строка не найдена.', 404);
    if (line.clinic_item_id == null) throw new RpcError('Это не выдача товара.', 400);
    if (line.invoice_item_id != null) throw new RpcError('Строка уже в счёте — сначала уберите её из счёта.', 400);
    // HOLDINGS_FIRST_V1 — движений у строки может быть НЕСКОЛЬКО: цепочка
    // списания покрывает дозу частями (3 из подотчёта, 7 со склада), и каждая
    // часть возвращается своему источнику. Прежний «ORDER BY id DESC LIMIT 1»
    // вернул бы только последнюю, а остальное растворилось бы.
    const mvs = db.prepare(`SELECT * FROM stock_movements WHERE reference_type = ? AND reference_id = ? AND kind = 'dispense' ORDER BY id`)
      .all(refType, id);
    if (!mvs.length) throw new RpcError('Движение склада по этой строке не найдено.', 400);
    for (const mv of mvs) {
      const holder = mv.holder_type ? { type: mv.holder_type, id: mv.holder_id } : null;
      // Back to where it came from: the holder the movement names, or the warehouse.
      if (holder) moveHolding(db, holder, line.clinic_item_id, -mv.qty);   // mv.qty is negative
      else db.prepare("UPDATE products SET on_hand = on_hand + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(-mv.qty, line.clinic_item_id);
      db.prepare(`
        INSERT INTO stock_movements (product_id, kind, qty, reference_type, reference_id, created_by, holder_type, holder_id)
        VALUES (?, 'void', ?, ?, ?, ?, ?, ?)`).run(line.clinic_item_id, -mv.qty, refType, id, user.id, holder ? holder.type : null, holder ? holder.id : null);
    }
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return { ok: true };
  });
  return run();
}

/**
 * outpatients_today — the nurse's list: today's outpatient visits with the
 * patient and the doctor, and what has already been dispensed on each.
 * args: { date?: 'YYYY-MM-DD' }
 */
export function outpatientsToday(db, args, user) {
  requireRole(user, LIST_ROLES);
  const a = args || {};
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(a.date || '')) ? String(a.date) : today(db);
  const visits = db.prepare(`
    SELECT v.id, v.visit_date, v.status, v.patient_id, v.doctor_id,
           p.full_name AS patient_name, p.mrn, p.allergies, p.date_of_birth, p.gender,
           u.full_name AS doctor_name,
           (SELECT COUNT(*) FROM visit_services vs WHERE vs.visit_id = v.id AND vs.service_id IS NOT NULL) AS service_count,
           (SELECT COUNT(*) FROM visit_services vs WHERE vs.visit_id = v.id AND vs.clinic_item_id IS NOT NULL) AS item_count
      FROM visits v
      JOIN patients p ON p.id = v.patient_id
      LEFT JOIN users u ON u.id = v.doctor_id
     WHERE ${localDate('v.visit_date')} = ?
       AND v.status NOT IN ('cancelled', 'no_show')
       AND COALESCE(v.visit_type, 'outpatient') = 'outpatient'
     ORDER BY v.visit_date, v.id`).all(day);
  return { date: day, visits };
}

/** visit_items — dispensed products on one visit (the nurse's «выдано» list). */
export function visitItems(db, args, user) {
  requireRole(user, LIST_ROLES);
  const visitId = Number(args && args.visit_id);
  if (!isPosInt(visitId)) throw new RpcError('visit_id обязателен.', 400);
  // HOLDINGS_FIRST_V1 — держатель читается ПОДЗАПРОСОМ, а не соединением:
  // движений у одной строки теперь бывает несколько (доза, покрытая частями),
  // и LEFT JOIN размножил бы саму строку выдачи — одна выдача выглядела бы
  // двумя. holder_type — первый источник, holding_parts отвечает на вопрос
  // «бралось ли хоть что-то из подотчёта».
  const mvWhere = "m.reference_type = 'visit' AND m.reference_id = vs.id AND m.kind = 'dispense'";
  const rows = db.prepare(`
    SELECT vs.id, vs.clinic_item_id AS product_id, p.name AS product_name, p.consumption_unit, p.base_unit,
           vs.quantity, vs.unit_price, vs.total, vs.invoice_item_id, vs.created_at, vs.created_by,
           u.full_name AS created_by_name,
           (SELECT m.holder_type FROM stock_movements m WHERE ${mvWhere} ORDER BY m.id LIMIT 1) AS holder_type,
           (SELECT m.holder_id   FROM stock_movements m WHERE ${mvWhere} ORDER BY m.id LIMIT 1) AS holder_id,
           (SELECT COUNT(*) FROM stock_movements m WHERE ${mvWhere} AND m.holder_type IS NOT NULL) AS holding_parts
      FROM visit_services vs
      JOIN products p ON p.id = vs.clinic_item_id
      LEFT JOIN users u ON u.id = vs.created_by
     WHERE vs.visit_id = ? AND vs.clinic_item_id IS NOT NULL
     ORDER BY vs.id`).all(visitId);
  return { items: rows.map((r) => ({ ...r, unit: r.consumption_unit || r.base_unit || '', from_holding: r.holding_parts > 0, invoiced: r.invoice_item_id != null, can_void: r.invoice_item_id == null })) };
}
