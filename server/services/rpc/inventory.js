// Server-side inventory RPCs. on_hand is writable ONLY through these
// handlers, and every change is paired with a stock_movements ledger row.
// All work runs inside db.transaction(...)() so a rejected dispense (e.g.
// insufficient stock) leaves on_hand, visit_services, and stock_movements
// completely untouched.

import { hasAnyRole } from '../roles.js';
// BRANCH_MONEY_GUARD_V1 — одна проверка «своё ли это здание» на весь сервер
// (billing.js), а не копия в каждом файле: отказ обязан звучать одинаково.
import { assertOwnBuilding } from './billing.js';
// INPATIENT_FLOW_V1 — «нет лечащего врача — нет лечения» (решение владельца
// 2026-09-04). Проверка живёт в одном месте на весь стационар, а не копией
// здесь: см. rpc/inpatient-flow.js.
import { assertAdmissionAtLeast } from './inpatient-flow.js';

export class RpcError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

const RECEIVE_ROLES = ['admin', 'inventory'];
const DISPENSE_ROLES = ['admin', 'doctor', 'nurse', 'inventory'];
// DOCTOR_WORKSPACE_V1 — a doctor can void their own not-yet-invoiced dispense
// from the workspace (easymed's void_dispensed_visit_item allows it; the
// invoiced-line guard in voidDispense still blocks anything billed).
const VOID_ROLES = ['admin', 'inventory', 'doctor'];

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

// No clinic single operation legitimately exceeds this. A finite-but-absurd
// quantity (e.g. 1e308) would otherwise pass a bare `> 0 && isFinite` check
// and overflow on_hand to Infinity, permanently defeating the
// insufficient-stock guard (Infinity < anything is always false).
const MAX_QTY = 1_000_000;

function requireQuantity(quantity) {
  if (!(typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0 && quantity <= MAX_QTY)) {
    throw new RpcError(`quantity must be a positive number up to ${MAX_QTY}.`, 400);
  }
}

function optPosInt(v, name) {
  if (v === undefined || v === null) {
    return null;
  }
  if (!(Number.isInteger(v) && v > 0)) {
    throw new RpcError(`${name} must be a positive integer.`, 400);
  }
  return v;
}

export function receiveStock(db, args, user) {
  requireRole(user, RECEIVE_ROLES);

  const productId = args && args.product_id;
  if (!isPositiveInt(productId)) {
    throw new RpcError('product_id must be a positive integer.', 400);
  }
  const quantity = args && args.quantity;
  requireQuantity(quantity);
  const unitCost = args && args.unit_cost;
  const unitCostValue = typeof unitCost === 'number' && Number.isFinite(unitCost) ? unitCost : null;
  const note = (args && args.note) || '';

  const run = db.transaction(() => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) {
      throw new RpcError('product not found.', 400);
    }

    // With the MAX_QTY cap this can't overflow, but assert anyway — belt and braces.
    const next = round2(product.on_hand + quantity);
    if (!Number.isFinite(next)) {
      throw new RpcError('resulting stock is out of range.', 400);
    }

    db.prepare(`
      UPDATE products
      SET on_hand = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `).run(next, productId);

    db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, note, created_by)
      VALUES (?, 'receive', ?, ?, 'manual', ?, ?)
    `).run(productId, quantity, unitCostValue, note, user.id);

    const fresh = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(productId);
    return { product_id: productId, on_hand: fresh.on_hand };
  });

  return run();
}

export function dispenseItem(db, args, user) {
  requireRole(user, DISPENSE_ROLES);

  const productId = args && args.product_id;
  if (!isPositiveInt(productId)) {
    throw new RpcError('product_id must be a positive integer.', 400);
  }
  const quantity = args && args.quantity;
  requireQuantity(quantity);
  const visitId = optPosInt(args && args.visit_id, 'visit_id');
  const doctorId = optPosInt(args && args.doctor_id, 'doctor_id');

  const run = db.transaction(() => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) {
      throw new RpcError('product not found.', 400);
    }
    if (!product.active) {
      throw new RpcError('product is not active.', 400);
    }
    if (product.on_hand < quantity) {
      throw new RpcError(`insufficient stock: on hand ${product.on_hand}, requested ${quantity}`, 400);
    }

    db.prepare(`
      UPDATE products
      SET on_hand = on_hand - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `).run(quantity, productId);

    let visitServiceId = null;
    if (visitId != null) {
      const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
      if (!visit) {
        throw new RpcError('visit not found.', 400);
      }
      const unitPrice = product.sale_price;
      const total = round2(unitPrice * quantity);
      const info = db.prepare(`
        INSERT INTO visit_services (visit_id, clinic_item_id, service_id, doctor_id, quantity, unit_price, total, status, created_by)
        VALUES (?, ?, NULL, ?, ?, ?, ?, 'added', ?)
      `).run(visitId, productId, doctorId, quantity, unitPrice, total, user.id);
      visitServiceId = info.lastInsertRowid;
    }

    db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, reference_type, reference_id, created_by)
      VALUES (?, 'dispense', ?, ?, ?, ?)
    `).run(productId, -quantity, visitId != null ? 'visit' : 'manual', visitServiceId, user.id);

    const fresh = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(productId);
    return { product_id: productId, item_name: product.name, on_hand: fresh.on_hand, visit_service_id: visitServiceId };
  });

  return run();
}

export function voidDispense(db, args, user) {
  requireRole(user, VOID_ROLES);

  const visitServiceId = args && args.visit_service_id;
  if (!isPositiveInt(visitServiceId)) {
    throw new RpcError('visit_service_id must be a positive integer.', 400);
  }

  const run = db.transaction(() => {
    const line = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(visitServiceId);
    if (!line) {
      throw new RpcError('line not found.', 400);
    }
    // BRANCH_MONEY_GUARD_V1 — чужую строку отсюда не отменяют. Сегодня сюда не
    // доедет ни одна ВЫДАННАЯ строка (clinic_item_id — местная ссылка, она не
    // ездит, и проверка ниже отвергла бы такую строку как «не выдача»), но
    // запрет стоит там, где стоит DELETE, а не там, где сегодня о нём известно:
    // удаление строки визита чеканит надгробие (миграция 084), и оно стёрло бы
    // строку у соседа. Ту же цену уже заплатили один раз в billing.js
    // (remove_unpaid_service) — второй раз платить незачем.
    assertOwnBuilding(db, line, 'Услуга');
    if (line.clinic_item_id == null) {
      throw new RpcError('not a dispensed line.', 400);
    }
    if (line.invoice_item_id != null) {
      throw new RpcError('cannot void an invoiced line.', 400);
    }

    db.prepare(`
      UPDATE products
      SET on_hand = on_hand + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `).run(line.quantity, line.clinic_item_id);

    db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, reference_type, reference_id, created_by)
      VALUES (?, 'void', ?, 'visit', ?, ?)
    `).run(line.clinic_item_id, line.quantity, visitServiceId, user.id);

    db.prepare('DELETE FROM visit_services WHERE id = ?').run(visitServiceId);

    const fresh = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(line.clinic_item_id);
    if (!fresh) {
      throw new RpcError('product not found.', 400);
    }
    return { product_id: line.clinic_item_id, on_hand: fresh.on_hand };
  });

  return run();
}

// =============================================================================
// BED_CONSOLE_V1 — стационарная выдача препаратов (easymed's
// dispense_admission_item / void_dispensed_admission_item). Атомарно:
// остаток товара + строка admission_services (+ журнал движений).
// =============================================================================
export function dispenseAdmissionItem(db, args, user) {
  requireRole(user, DISPENSE_ROLES);
  const admissionId = args && args.admission_id;
  if (!isPositiveInt(admissionId)) throw new RpcError('admission_id must be a positive integer.', 400);
  const productId = args && args.product_id;
  if (!isPositiveInt(productId)) throw new RpcError('product_id must be a positive integer.', 400);
  const quantity = args && args.quantity;
  requireQuantity(quantity);
  const doctorId = optPosInt(args && args.doctor_id, 'doctor_id');
  // BED_CONSOLE_V2 — «Выставить в счёт пациенту»: по умолчанию true (совместимо
  // со старым admission-modal); консоль передаёт явный выбор из чекбокса.
  const billable = (args && args.billable !== undefined) ? !!args.billable : true;
  const note = (args && typeof args.note === 'string' ? args.note.trim().slice(0, 300) : '') || null;

  const run = db.transaction(() => {
    // INPATIENT_FLOW_V1 — было `adm.status !== 'active'`, и это ПРАВИЛО
    // СОХРАНЕНО ДОСЛОВНО: выдать препарат можно, только когда лечение
    // действительно началось, а закрытой (выписанной или отменённой)
    // госпитализации — нельзя вовсе. Изменилось одно: отказ теперь называет
    // недостающий шаг («Пациент ещё не осмотрен главным врачом») вместо
    // «admission is not active», и то же самое правило спрашивают все
    // остальные задачи маршрута — одной функцией, а не своей копией.
    //
    // Здесь именно assertAdmissionAtLeast, а НЕ assertCanPrescribe: препарат у
    // койки выдаёт медсестра, и она не лечащий врач. Кому можно выдавать,
    // решает DISPENSE_ROLES выше; эта строка отвечает только на вопрос «дошёл
    // ли пациент до лечения».
    const adm = assertAdmissionAtLeast(db, admissionId, 'active');
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new RpcError('product not found.', 400);
    if (!product.active) throw new RpcError('product is not active.', 400);
    if (product.on_hand < quantity) {
      throw new RpcError(`insufficient stock: on hand ${product.on_hand}, requested ${quantity}`, 400);
    }

    db.prepare(`UPDATE products SET on_hand = on_hand - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .run(quantity, productId);

    const unitPrice = product.sale_price;
    const total = round2(unitPrice * quantity);
    const info = db.prepare(`
      INSERT INTO admission_services (admission_id, clinic_item_id, service_id, doctor_id, bed_id, ward_id, quantity, unit_price, total, status, billable, notes, performed_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'added', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    `).run(admissionId, productId, doctorId, adm.bed_id, adm.ward_id, quantity, unitPrice, total, billable ? 1 : 0, note);

    db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, reference_type, reference_id, created_by)
      VALUES (?, 'dispense', ?, 'admission', ?, ?)
    `).run(productId, -quantity, info.lastInsertRowid, user.id);

    const fresh = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(productId);
    return { line_id: info.lastInsertRowid, item_name: product.name, on_hand: fresh.on_hand };
  });
  return run();
}

export function voidDispensedAdmissionItem(db, args, user) {
  requireRole(user, VOID_ROLES);
  const lineId = args && args.line_id;
  if (!isPositiveInt(lineId)) throw new RpcError('line_id must be a positive integer.', 400);

  const run = db.transaction(() => {
    const line = db.prepare('SELECT * FROM admission_services WHERE id = ?').get(lineId);
    if (!line) throw new RpcError('line not found.', 400);
    if (line.clinic_item_id == null) throw new RpcError('not a dispensed line.', 400);
    if (line.invoice_item_id != null) throw new RpcError('cannot void an invoiced line.', 400);

    db.prepare(`UPDATE products SET on_hand = on_hand + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .run(line.quantity, line.clinic_item_id);
    db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, reference_type, reference_id, created_by)
      VALUES (?, 'void', ?, 'admission', ?, ?)
    `).run(line.clinic_item_id, line.quantity, lineId, user.id);
    db.prepare('DELETE FROM admission_services WHERE id = ?').run(lineId);

    const fresh = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(line.clinic_item_id);
    return { product_id: line.clinic_item_id, on_hand: fresh ? fresh.on_hand : null };
  });
  return run();
}
