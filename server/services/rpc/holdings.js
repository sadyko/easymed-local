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
// EXPIRY_BALANCE_V1 — «выдача и списание просроченного предупреждают» (владелец
// 23.09). Дверь медсестры отвечает теми же словами, что склад и койка.
import { expiryWarnings } from './expiry.js';
// STOCK_REQUEST_V1 — автозаявка по минимуму: зовётся ЗДЕСЬ, в единственной
// записи остатка держателя, после каждого уменьшения.
import { afterHoldingDecrease } from './stock-requests.js';
// STOCK_QTY_V1 (V3120_FIX) — шесть знаков и «пыль округления — ноль» на всех
// записях остатка: см. domain/stock-qty.js.
import { roundQty, factorOf, toBase, settleQty, coversQty, unitsOf } from '../domain/stock-qty.js';
// V3120_FIX — дверь медсестры списывает ОДНОЙ цепочкой со всеми дверями
// (свой подотчёт → кабинет → отдел → склад). Импорт взаимный (inventory.js
// берёт отсюда moveHolding/moveWarehouse), и это безопасно: обе стороны
// зовут друг друга только внутри функций, не при загрузке модуля.
import { holdingChain, planSources, applySources } from './inventory.js';

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
  return factorOf(product);
}

/** Фактор расхода товара по его id (1, если товара или единицы расхода нет). */
function factorOfId(db, productId) {
  return factorOf(db.prepare('SELECT consumption_unit, consumption_factor FROM products WHERE id = ?').get(productId));
}

/**
 * STOCK_QTY_V1 (V3120_FIX) — ЕДИНСТВЕННАЯ запись products.on_hand при расходе,
 * возврате и отмене: `delta` со знаком, итог — шесть знаков, пыль округления —
 * ноль. Прежде каждая дверь писала `on_hand = on_hand ± ?` сама, и остаток
 * копил хвосты вида 8.833333000000001. Проверку «хватает ли» делает
 * вызывающий (у каждой двери свои слова отказа); здесь — последний замок.
 */
export function moveWarehouse(db, productId, delta) {
  const row = db.prepare('SELECT on_hand, consumption_unit, consumption_factor FROM products WHERE id = ?').get(productId);
  if (!row) throw new RpcError('Товар не найден.', 404);
  const next = settleQty(Number(row.on_hand) + Number(delta), factorOf(row));
  if (next < 0) throw new RpcError('Недостаточно на складе.', 400);
  db.prepare("UPDATE products SET on_hand = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(next, productId);
  return next;
}

/**
 * Add `baseQty` (may be negative) to a holder's line; refuses to go below zero.
 *
 * STOCK_REQUEST_V1 — ЭТО ЕДИНСТВЕННОЕ МЕСТО, где пишется stock_holdings (склад,
 * одобрение заявки, цепочка списания inventory.js, дверь медсестры, отмены).
 * Поэтому автозаявка по минимуму стоит здесь, одна на все двери: остаток
 * уменьшился — проверяем минимум (rpc/stock-requests.js afterHoldingDecrease).
 * Она никогда не бросает в списание и живёт в его транзакции. `actorId` — кто
 * списал: он и значится подавшим автозаявку.
 */
export function moveHolding(db, holder, productId, baseQty, actorId = null, opts = {}) {
  const row = db.prepare('SELECT id, qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?')
    .get(holder.type, holder.id, productId);
  // STOCK_QTY_V1 — было round2: 1/7 пачки записывалась как 0.14, и седьмая
  // таблетка оставляла на руках 0.02 пачки навсегда.
  const next = settleQty((row ? row.qty : 0) + baseQty, factorOfId(db, productId));
  if (next < 0) {
    throw new RpcError('Недостаточно на руках: у получателя меньше, чем выдаётся.', 400);
  }
  if (row) {
    db.prepare("UPDATE stock_holdings SET qty = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(next, row.id);
  } else {
    db.prepare('INSERT INTO stock_holdings (holder_type, holder_id, product_id, qty) VALUES (?, ?, ?, ?)').run(holder.type, holder.id, productId, next);
  }
  // V3120_FIX — возврат подотчёта на склад (holding_return) автозаявку не
  // подаёт: остаток уменьшился не расходом, а решением кладовщика.
  if (baseQty < 0 && opts.autoRequest !== false) afterHoldingDecrease(db, holder, productId, actorId);
  return next;
}

/**
 * V3120_FIX — holdings_list { reachable: true, visit_id? | admission_id? }:
 * ТОЛЬКО те полки, с которых ЭТОТ человек выдаёт ЭТОМУ пациенту, в порядке
 * цепочки (inventory.js holdingChain): свой подотчёт, кабинет приёма, свой
 * кабинет, отдел кабинета или палаты, свой отдел. Без места — свой подотчёт,
 * свой кабинет, свой отдел. Считает сервер из сессии, как и `mine`: экрану
 * медсестры больше не приезжают чужие карманы и чужие отделения, которые он
 * раньше предлагал как источник. Роль не спрашивается: свои полки человек
 * вправе видеть всегда (заведующей и старшей нет в LIST_ROLES).
 */
function reachableHoldings(db, a, user) {
  if (!isPosInt(Number(user && user.id))) throw new RpcError('Вошедший не опознан.', 401);
  let place = {};
  if (a.visit_id != null) {
    const visit = db.prepare('SELECT id, room_id FROM visits WHERE id = ?').get(Number(a.visit_id));
    if (!visit) throw new RpcError('Визит не найден.', 404);
    place = { visit };
  } else if (a.admission_id != null) {
    const admission = db.prepare('SELECT id, ward_id FROM admissions WHERE id = ?').get(Number(a.admission_id));
    if (!admission) throw new RpcError('Госпитализация не найдена.', 404);
    place = { admission };
  }
  const chain = holdingChain(db, user, place);
  const out = [];
  chain.forEach((c, rank) => {
    const { holdings } = holdingsListRows(db, ['h.holder_type = ?', 'h.holder_id = ?', 'h.qty > 0'], [c.type, c.id]);
    for (const row of holdings) out.push({ ...row, chain_rank: rank });
  });
  return { holdings: out };
}

/**
 * holdings_list — what holders have on hand.
 * args: { mine?, holder_type?, holder_id?, include_empty? }  (no holder → every holder)
 * → { holdings: [{ holder_type, holder_id, holder_name, product_id, product_name,
 *      base_unit, consumption_unit, consumption_factor, sale_price, qty_base, qty_units }] }
 * qty_units = qty in the consumption unit — what the nurse counts in.
 *
 * MY_STOCK_V1 — «МОЁ» СЧИТАЕТ СЕРВЕР, А НЕ ОТБОР В БРАУЗЕРЕ. Экран «Мои
 * запасы» просит `mine: true` и НЕ называет держателя: имя берётся из сессии,
 * чужие строки до экрана не доезжают, и подменить их в запросе нечем —
 * holder_type/holder_id при `mine` не читаются вовсе. Роль тут не
 * спрашивается: что числится за человеком, человек вправе видеть всегда, а
 * заведующей и старшей медсестры в LIST_ROLES нет — они получили бы 403 на
 * собственном подотчёте.
 */
export function holdingsList(db, args, user) {
  const a = args || {};
  if (a.reachable === true) return reachableHoldings(db, a, user);
  const mine = a.mine === true;
  const selfId = Number(user && user.id);
  if (mine) {
    if (!isPosInt(selfId)) throw new RpcError('Вошедший не опознан.', 401);
  } else {
    requireRole(user, LIST_ROLES);
  }
  const where = ['1=1'];
  const params = [];
  if (mine) {
    where.push("h.holder_type = 'staff'", 'h.holder_id = ?');
    params.push(selfId);
  } else {
    if (a.holder_type) {
      if (!HOLDER_TYPES.includes(a.holder_type)) throw new RpcError('holder_type неизвестен.', 400);
      where.push('h.holder_type = ?'); params.push(a.holder_type);
    }
    if (a.holder_id != null) { where.push('h.holder_id = ?'); params.push(Number(a.holder_id)); }
  }
  if (!a.include_empty) where.push('h.qty > 0');
  return holdingsListRows(db, where, params);
}

function holdingsListRows(db, where, params) {
  const rows = db.prepare(`
    SELECT h.holder_type, h.holder_id, h.product_id, h.qty,
           p.name AS product_name, p.base_unit, p.consumption_unit, p.consumption_factor, p.sale_price, p.is_drug, p.active,
           CASE WHEN h.holder_type = 'staff' THEN (SELECT is_active FROM users WHERE id = h.holder_id) ELSE 1 END AS holder_active,
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
        // V3120_FIX — держатель-сотрудник отключён: экран предлагает вернуть
        // его подотчёт на склад или передать (holding_return).
        holder_inactive: r.holder_active != null && Number(r.holder_active) === 0,
        qty_base: roundQty(r.qty), qty_units: unitsOf(r.qty, cf),
      };
    }),
  };
}

/**
 * dispense_from_holding — a nurse gives a patient something she (her cabinet,
 * her department) holds. Bills the visit or the admission like the other
 * dispense doors, at the sale price per consumption unit.
 * args: { holder?:{type,id}, product_id, quantity (consumption units), visit_id? | admission_id?,
 *         billable? (default true), note? }
 *
 * V3120_FIX — «ВЫДАЁТ СО СВОЕЙ ПОЛКИ» (владелец 27.09: «подтвердите, что
 * выдача врачом или медсестрой идёт с их собственной полки; если нет —
 * исправьте»).
 *
 * ЧТО БЫЛО. Эта дверь одна из всех жила мимо цепочки HOLDINGS_FIRST_V1:
 * источник брался из запроса КАК ЕСТЬ. Экран предлагал медсестре каждый
 * кабинет и каждое отделение клиники (holdings_list без отбора), а сервер
 * принимал любого держателя, включая личный подотчёт ДРУГОГО сотрудника, —
 * проверялось только, что такой держатель существует. «Склад» списывал склад,
 * даже когда то же самое лежало у медсестры на руках, а нехватка на выбранной
 * полке была отказом, хотя вторая своя полка могла добрать.
 *
 * ЧТО СТАЛО. Списание — та же ОДНА цепочка, что у всех дверей
 * (inventory.js holdingChain → planSources → applySources):
 *   • названный держатель обязан быть СВОИМ — в цепочке этой выдачи (свой
 *     подотчёт, кабинет приёма, свой кабинет, отдел кабинета или палаты, свой
 *     отдел). Чужой — 403 до первой записи. Админ и кладовщик ведут склад
 *     клиники и вправе назвать любой кабинет или отдел, но чужой карман — никто;
 *   • названный свой держатель берётся ПЕРВЫМ (медсестра говорит, из какого
 *     шкафа она достала), недостача добирается остальной цепочкой, склад —
 *     последним;
 *   • «Склад» или держатель не назван — просто цепочка: склад только тогда,
 *     когда своих полок не хватило.
 */
function assertOwnHolder(db, user, named, chain) {
  if (named.type === 'staff') {
    if (Number(named.id) === Number(user && user.id)) return;
    throw new RpcError('Выдавать можно только из своих запасов: личный подотчёт другого сотрудника не трогается.', 403);
  }
  if (chain.some((c) => c.type === named.type && Number(c.id) === Number(named.id))) return;
  if (hasAnyRole(user, ['admin', 'inventory'])) return;
  const what = named.type === 'room' ? 'не ваш кабинет и не кабинет приёма' : 'не ваше отделение и не отделение этого приёма';
  throw new RpcError(`«${named.name}» — ${what}: выдавайте из своих запасов.`, 403);
}

export function dispenseFromHolding(db, args, user) {
  requireRole(user, DISPENSE_ROLES);
  const a = args || {};
  const productId = a.product_id;
  if (!isPosInt(productId)) throw new RpcError('Товар не выбран.', 400);
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
    // Не назван или назван склад — решает цепочка (склад в ней последний).
    const named = a.holder && a.holder.type !== WAREHOUSE ? resolveHolder(db, a.holder) : null;
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new RpcError('Товар не найден.', 400);
    const cf = consumptionFactor(product);
    const baseQty = toBase(qtyUnits, cf);
    if (!(baseQty > 0)) throw new RpcError('Количество слишком мало.', 400);

    let visit = null;
    let adm = null;
    if (visitId) {
      visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
      if (!visit) throw new RpcError('Визит не найден.', 400);
    } else {
      adm = assertAdmissionAtLeast(db, admissionId, 'active');
    }
    const own = holdingChain(db, user, visit ? { visit } : { admission: adm });
    if (named) assertOwnHolder(db, user, named, own);
    const chain = named
      ? [{ type: named.type, id: named.id }, ...own.filter((c) => !(c.type === named.type && Number(c.id) === Number(named.id)))]
      : own;
    // Нигде не хватило — отказ со словами ДО первой записи (planSources). Отключённый
    // товар: со своих полок довыдать можно, со склада — нет (там же).
    const picks = planSources(db, chain, product, baseQty, { inUnits: true });
    // EXPIRY_BALANCE_V1 — партия смотрится ДО списания. Тревожит ТОВАР, а не
    // источник: у подотчёта партии не записаны, но просроченная коробка в
    // клинике одна, из чьих бы рук её ни взяли.
    const warnings = expiryWarnings(db, [productId]);

    // Price per consumption unit — the sale price is per base unit.
    const unitPrice = round2(Number(product.sale_price) / cf);
    const total = round2(unitPrice * qtyUnits);
    let lineId = null;
    let refType = 'visit';
    if (visit) {
      lineId = db.prepare(`
        INSERT INTO visit_services (visit_id, clinic_item_id, service_id, doctor_id, quantity, unit_price, total, status, created_by)
        VALUES (?, ?, NULL, NULL, ?, ?, ?, 'added', ?)`).run(visitId, productId, qtyUnits, billable ? unitPrice : 0, billable ? total : 0, user.id).lastInsertRowid;
    } else {
      refType = 'admission';
      lineId = db.prepare(`
        INSERT INTO admission_services (admission_id, clinic_item_id, service_id, doctor_id, bed_id, ward_id, quantity, unit_price, total, status, billable, notes, performed_at)
        VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'added', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
        .run(admissionId, productId, adm.bed_id, adm.ward_id, qtyUnits, unitPrice, total, billable ? 1 : 0, note || null).lastInsertRowid;
    }
    // Одно движение на каждый источник, общая ссылка на строку: отмена
    // (void_holding_dispense) вернёт каждую часть своему держателю.
    applySources(db, picks, productId, user, refType, lineId, note);

    // «Осталось» — у первого источника: там, откуда медсестра брала.
    const first = picks[0];
    let leftBase = 0;
    if (first.type !== WAREHOUSE) {
      const left = db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(first.type, first.id, productId);
      leftBase = left ? left.qty : 0;
    } else {
      leftBase = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(productId).on_hand;
    }
    return {
      line_id: lineId, item_name: product.name, unit_price: unitPrice, total, left_units: unitsOf(leftBase, cf),
      source: first.type, sources: picks, warnings,
    };
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
      else moveWarehouse(db, line.clinic_item_id, -mv.qty);
      db.prepare(`
        INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, created_by, holder_type, holder_id)
        VALUES (?, 'void', ?, ?, ?, ?, ?, ?, ?)`).run(line.clinic_item_id, -mv.qty, mv.unit_cost, refType, id, user.id, holder ? holder.type : null, holder ? holder.id : null);

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

// =============================================================================
// V3120_FIX — holding_return: «Вернуть на склад / передать».
//
// Инспекция: товар, выданный на руки медсестре, после её отключения висел за
// ней навсегда — выдать его пациенту некому (вход закрыт), а вернуть было
// нечем: обратной двери у выдачи не было. Отсюда и дверь. Нужна она прежде
// всего для подотчёта отключённых сотрудников (экран ставит кнопку у них), но
// сервер не запирает её на это: кладовщик вправе вернуть на склад и
// подотчёт кабинета, который закрыли.
//
// ЗАПИСЬ В ЖУРНАЛ — это ВЫДАЧА С ОБРАТНЫМ ЗНАКОМ: kind 'dispense',
// reference_type 'issue', qty > 0, держатель — тот, от кого вернули. Так её
// без новых правил понимают все, кто уже считает выдачи: журнал (вид «Выдача»),
// отчёты склада (WAREHOUSE_LEDGER_SQL в rpc/reports.js: склад +, держатель −) и
// карточка отдела. Передача другому держателю — две такие записи: возврат на
// склад и выдача получателю; склад в итоге не меняется.
//
// args: { holder: {type,id}, product_id, quantity? (базовые; нет — всё),
//         to?: {type,id} (нет — на склад), note? }
// → { product_id, returned_base, returned_units, unit, to: {type,id,name}|null }
// =============================================================================
const RETURN_ROLES = ['admin', 'inventory'];

export function holdingReturn(db, args, user) {
  requireRole(user, RETURN_ROLES);
  const a = args || {};
  const productId = Number(a.product_id);
  if (!isPosInt(productId)) throw new RpcError('Товар не выбран.', 400);
  const extra = typeof a.note === 'string' ? a.note.trim().slice(0, 300) : '';

  const run = db.transaction(() => {
    const from = resolveHolder(db, a.holder);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new RpcError('Товар не найден.', 404);
    const cf = factorOf(product);
    const unit = product.base_unit || product.unit || '';
    const row = db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(from.type, from.id, productId);
    const have = row ? Number(row.qty) : 0;
    if (!(have > 0)) throw new RpcError(`У «${from.name}» нет на руках: ${product.name}.`, 400);

    let qty = have;
    if (a.quantity !== undefined && a.quantity !== null && a.quantity !== '') {
      const q = roundQty(a.quantity);
      if (!(Number.isFinite(q) && q > 0 && q <= MAX_QTY)) throw new RpcError('Количество — положительное число.', 400);
      if (!coversQty(have, q, cf)) throw new RpcError(`Больше, чем числится: у «${from.name}» ${roundQty(have)} ${unit} — ${product.name}.`.replace(/\s+/g, ' '), 400);
      qty = Math.min(q, have);
    }

    let to = null;
    if (a.to && typeof a.to === 'object' && a.to.type !== WAREHOUSE) {
      to = resolveHolder(db, a.to);
      if (to.type === from.type && to.id === from.id) throw new RpcError('Передать можно только другому держателю.', 400);
      if (to.type === 'staff') {
        const u = db.prepare('SELECT is_active FROM users WHERE id = ?').get(to.id);
        if (u && Number(u.is_active) === 0) throw new RpcError(`${to.name || 'Сотрудник'} отключён — передать ему на руки нельзя.`, 400);
      }
    }

    const ins = db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, note, created_by, branch_id, holder_type, holder_id)
      VALUES (?, 'dispense', ?, ?, 'issue', ?, ?, 1, ?, ?)`);
    const tail = extra ? ` — ${extra}` : '';
    // 1. От держателя на склад.
    moveHolding(db, from, productId, -qty, user.id, { autoRequest: false });
    moveWarehouse(db, productId, qty);
    ins.run(productId, qty, product.avg_cost, (to ? `Передача: ${from.name} → ${to.name}` : `Возврат на склад от: ${from.name}`) + tail,
      user.id, from.type, from.id);
    // 2. Со склада получателю (передача).
    if (to) {
      moveWarehouse(db, productId, -qty);
      moveHolding(db, to, productId, qty);
      ins.run(productId, -qty, product.avg_cost, `${to.name} — передача от: ${from.name}${tail}`, user.id, to.type, to.id);
    }
    return {
      product_id: productId, returned_base: qty, returned_units: unitsOf(qty, cf),
      unit: product.consumption_unit || unit, to: to ? { type: to.type, id: to.id, name: to.name } : null,
    };
  });
  return run();
}
