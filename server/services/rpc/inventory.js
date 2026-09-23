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
// HOLDINGS_V1 — what the ward already holds is used before the warehouse.
// HOLDINGS_FIRST_V1 — и это теперь правило ВСЕХ дверей, а не флаг двух из них.
import { moveHolding, WAREHOUSE } from './holdings.js';
// EXPIRY_BALANCE_V1 — «выдача и списание просроченного предупреждают» (владелец
// 23.09). Предупреждение НЕ отказ: оно едет в ответе рядом с результатом, и
// считает его сервер — иначе каждая из восьми дверей сказала бы своими словами.
import { expiryWarnings } from './expiry.js';

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

// =============================================================================
// HOLDINGS_FIRST_V1 (2026-09-23) — ОДНА ЦЕПОЧКА СПИСАНИЯ НА ВСЕ ДВЕРИ.
//
// Владелец (23.09), решение по второму вопросу: «Сначала свой подотчёт, потом
// отдел, потом склад. Везде.»
//
// ЧТО БЫЛО. О подотчёте знали ДВЕ двери из восьми: амбулаторная вкладка
// медсестры (holdings.js dispense_from_holding, где источник называют руками) и
// отметка о введении дозы (она одна передавала prefer_holdings). Остальные
// шесть — койка, история болезни, кабинет врача, окно визита, процедуры, счёт
// визита — всегда брали СО СКЛАДА. Выданное медсестре, в кабинет или в
// отделение становилось призраком: склад платил за него второй раз, а когда
// склад пуст, консоль койки отказывала выдать лекарство, которое физически
// лежит в палате. Это и был баг владельца.
//
// ЧТО СТАЛО. Цепочка — не флаг, а ПОВЕДЕНИЕ ПО УМОЛЧАНИЮ, и она одна на визит
// и на госпитализацию:
//
//     свой подотчёт → кабинет, где шёл приём → отдел этого кабинета или
//     палаты → склад.
//
// УРОВЕНЬ, КОТОРОГО ЗДЕСЬ НЕТ, ПРОПУСКАЕТСЯ, А НЕ УГАДЫВАЕТСЯ. Палата не лежит
// в кабинете: у wards есть floor_id и department_id (миграции 082, 108), но
// room_id у неё нет и никогда не было. Поэтому у койки уровень «кабинет» —
// это только СОБСТВЕННЫЙ кабинет сотрудника (users.room_id, миграция 032), а
// «отдел» — отдел палаты (wards.department_id) и свой отдел
// (users.department_id, миграция 018). У визита кабинет приёма известен
// точно — visits.room_id (миграция 099).
//
// ПОКРЫТИЕ БЫВАЕТ ЧАСТИЧНЫМ, и это нормально: 3 из подотчёта медсестры и 7 со
// склада — в одной выдаче. На КАЖДЫЙ источник пишется своё движение с общим
// reference_id, и отмена возвращает каждую часть туда, откуда она пришла.
// Прежний поиск «кто покрывает всё целиком» отправлял на склад и ту дозу,
// которую подотчёт покрывал наполовину.
//
// ОТКАЗ НАЗЫВАЕТ ВСЁ, ДО ЧЕГО ДОТЯНУЛАСЬ ЦЕПОЧКА. «insufficient stock» говорил
// про склад и молчал про то, что половина лежит у сотрудника на руках.
// =============================================================================

/**
 * Кабинет и отдел самого сотрудника. В сессии их нет — services/auth.js
 * sessionUser этих колонок не носит, поэтому читаем из users.
 */
function actorPlaces(db, user) {
  const id = user && Number(user.id);
  if (!isPositiveInt(id)) return { room_id: null, department_id: null };
  const row = db.prepare('SELECT room_id, department_id FROM users WHERE id = ?').get(id);
  if (!row) return { room_id: null, department_id: null };
  return {
    room_id: isPositiveInt(row.room_id) ? row.room_id : null,
    department_id: isPositiveInt(row.department_id) ? row.department_id : null,
  };
}

function deptOfRoom(db, roomId) {
  const r = db.prepare('SELECT department_id FROM rooms WHERE id = ?').get(roomId);
  return r && isPositiveInt(r.department_id) ? r.department_id : null;
}

function deptOfWard(db, wardId) {
  const w = db.prepare('SELECT department_id FROM wards WHERE id = ?').get(wardId);
  return w && isPositiveInt(w.department_id) ? w.department_id : null;
}

/**
 * Держатели этого списания ПО ПОРЯДКУ. `place` — { visit } или { admission };
 * чего в ней нет, того нет и в цепочке.
 */
export function holdingChain(db, user, place) {
  const chain = [];
  const seen = new Set();
  const push = (type, id) => {
    if (!isPositiveInt(id)) return;
    const key = `${type}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    chain.push({ type, id });
  };
  const me = actorPlaces(db, user);
  const visit = place && place.visit;
  const adm = place && place.admission;

  push('staff', user && user.id);                                       // 1. свой подотчёт
  if (visit) push('room', visit.room_id);                               // 2. кабинет приёма
  push('room', me.room_id);                                             //    свой кабинет
  if (visit) push('department', deptOfRoom(db, visit.room_id));         // 3. отдел кабинета
  if (adm) push('department', deptOfWard(db, adm.ward_id));             //    отдел палаты
  push('department', me.department_id);                                 //    свой отдел
  return chain;
}

/** Отказ, который называет и нехватку, и всё, что цепочка нашла по дороге. */
function shortfallMessage(product, need, onHand, found) {
  const unit = product.base_unit || product.unit || '';
  const num = (v) => String(round2(v));
  const tail = [];
  if (found.staff > 0) tail.push(`у вас на руках ${num(found.staff)}`);
  if (found.room > 0) tail.push(`в кабинете ${num(found.room)}`);
  if (found.department > 0) tail.push(`в отделе ${num(found.department)}`);
  const head = `Недостаточно: ${product.name} — на складе ${num(onHand)} из ${num(need)}${unit ? ` ${unit}` : ''}`;
  return `${head}; ${tail.length ? tail.join(', ') : 'на руках, в кабинете и в отделе — ничего'}.`;
}

/**
 * Сколько и откуда возьмётся — БЕЗ ЕДИНОЙ ЗАПИСИ. Не хватило нигде — 400 со
 * словами, и вызывающая транзакция не тронула ни остатка, ни строки счёта.
 * Количества — базовые единицы товара, как products.on_hand и stock_holdings.qty.
 */
export function planSources(db, chain, product, quantity) {
  const q = db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?');
  const picks = [];
  const found = { staff: 0, room: 0, department: 0 };
  let need = round2(quantity);
  for (const c of chain) {
    const row = q.get(c.type, c.id, product.id);
    const have = row && row.qty > 1e-9 ? round2(row.qty) : 0;
    if (!have) continue;
    found[c.type] = round2(found[c.type] + have);
    if (need <= 1e-9) continue;                 // дальше идём только чтобы отказ знал правду
    const take = round2(Math.min(have, need));
    if (take <= 1e-9) continue;
    picks.push({ type: c.type, id: c.id, qty: take });
    need = round2(need - take);
  }
  if (need > 1e-9) {
    const onHand = round2(product.on_hand);
    if (onHand + 1e-9 < need) {
      throw new RpcError(shortfallMessage(product, quantity, onHand, found), 400);
    }
    picks.push({ type: WAREHOUSE, id: null, qty: need });
  }
  return picks;
}

/** Списать запланированное и записать ПО ДВИЖЕНИЮ НА ИСТОЧНИК. */
function applySources(db, picks, productId, user, refType, refId) {
  for (const p of picks) {
    if (p.type === WAREHOUSE) {
      db.prepare("UPDATE products SET on_hand = on_hand - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?")
        .run(p.qty, productId);
    } else {
      moveHolding(db, { type: p.type, id: p.id }, productId, -p.qty);
    }
    db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, reference_type, reference_id, created_by, holder_type, holder_id)
      VALUES (?, 'dispense', ?, ?, ?, ?, ?, ?)
    `).run(productId, -p.qty, refType, refId, user.id, p.type === WAREHOUSE ? null : p.type, p.type === WAREHOUSE ? null : p.id);
  }
  return picks;
}

/**
 * Вернуть КАЖДУЮ часть туда, откуда она пришла: источники читаются из движений
 * этой строки, а не угадываются. Движений нет вовсе (строка старше журнала) —
 * возвращаем на склад, как делали раньше.
 */
export function restoreSources(db, refType, refId, productId, fallbackQty, user) {
  const rows = db.prepare(`
    SELECT holder_type, holder_id, qty FROM stock_movements
     WHERE reference_type = ? AND reference_id = ? AND kind = 'dispense'
     ORDER BY id
  `).all(refType, refId);
  const parts = rows.length
    ? rows.map((r) => ({ type: r.holder_type || WAREHOUSE, id: r.holder_type ? r.holder_id : null, qty: round2(-r.qty) }))
    : (round2(fallbackQty) > 0 ? [{ type: WAREHOUSE, id: null, qty: round2(fallbackQty) }] : []);
  for (const p of parts) {
    if (p.type === WAREHOUSE) {
      db.prepare("UPDATE products SET on_hand = on_hand + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?")
        .run(p.qty, productId);
    } else {
      moveHolding(db, { type: p.type, id: p.id }, productId, p.qty);
    }
    db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, reference_type, reference_id, created_by, holder_type, holder_id)
      VALUES (?, 'void', ?, ?, ?, ?, ?, ?)
    `).run(productId, p.qty, refType, refId, user.id, p.type === WAREHOUSE ? null : p.type, p.type === WAREHOUSE ? null : p.id);
  }
  return parts;
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
    let visit = null;
    if (visitId != null) {
      visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
      if (!visit) {
        throw new RpcError('visit not found.', 400);
      }
    }

    // HOLDINGS_FIRST_V1 — свой подотчёт → кабинет приёма → отдел → склад.
    // Отказ (нигде не хватило) звучит ДО первой записи: транзакция уходит
    // назад нетронутой, как и при прежней проверке остатка.
    const picks = planSources(db, holdingChain(db, user, { visit }), product, quantity);
    // EXPIRY_BALANCE_V1 — партия смотрится ДО списания: тревожит та, которую
    // возьмут сейчас. Предупреждение проверяет ТОВАР, а не источник: партии у
    // подотчёта не записаны, но просроченная коробка стоит в клинике одна и та
    // же, из чьих бы рук её ни взяли.
    const warnings = expiryWarnings(db, [productId]);

    let visitServiceId = null;
    if (visit) {
      // Цена и строка визита — БЕЗ ИЗМЕНЕНИЙ: откуда взят товар, на счёт не влияет.
      const unitPrice = product.sale_price;
      const total = round2(unitPrice * quantity);
      const info = db.prepare(`
        INSERT INTO visit_services (visit_id, clinic_item_id, service_id, doctor_id, quantity, unit_price, total, status, created_by)
        VALUES (?, ?, NULL, ?, ?, ?, ?, 'added', ?)
      `).run(visitId, productId, doctorId, quantity, unitPrice, total, user.id);
      visitServiceId = info.lastInsertRowid;
    }

    applySources(db, picks, productId, user, visitId != null ? 'visit' : 'manual', visitServiceId);

    const fresh = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(productId);
    return { product_id: productId, item_name: product.name, on_hand: fresh.on_hand, visit_service_id: visitServiceId, sources: picks, warnings };
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

    // HOLDINGS_FIRST_V1 — возврат ИДЁТ ПО ИСТОЧНИКАМ, а не на склад скопом.
    // Раньше отсюда всё возвращалось на склад, и отмена выдачи из подотчёта
    // дарила складу чужой товар: у медсестры на руках его не прибавлялось, а
    // на складе прибавлялось. Разбитая на два источника выдача возвращается
    // двумя частями — каждая своему держателю.
    const parts = restoreSources(db, 'visit', visitServiceId, line.clinic_item_id, line.quantity, user);

    db.prepare('DELETE FROM visit_services WHERE id = ?').run(visitServiceId);

    const fresh = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(line.clinic_item_id);
    if (!fresh) {
      throw new RpcError('product not found.', 400);
    }
    return { product_id: line.clinic_item_id, on_hand: fresh.on_hand, sources: parts };
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
  return dispenseAdmissionItemCore(db, args, user);
}

// MED_ADMIN_CHARGE_V1 — ТО ЖЕ САМОЕ, но без вопроса о роли.
//
// Существует ради одного вызывающего: отметки медсестры о введении дозы
// (rpc/treatment-orders.js, Задача 6). Списание там уже разрешено — но ДРУГИМ
// списком ролей: дозу отмечает медсестра или старшая, снимает отметку только
// старшая, и оба списка живут в листе назначений, где они и решаются. Спроси
// мы здесь ещё и DISPENSE_ROLES/VOID_ROLES — на один вопрос было бы два
// ответа, и старшая медсестра, которой лист назначений снять отметку разрешил,
// получила бы 403 от склада на полпути, оставив дозу снятой, а деньги на месте.
//
// Второй экземпляр движения товара при этом НЕ заводится, и в этом весь смысл
// такой разделки: остаток, строка admission_services и запись в
// stock_movements пишутся ровно тем же кодом, что и у койки. Своя копия
// разъехалась бы с этой в мелочах (знак qty, reference_type, цена из
// каталога), и нашлось бы это при сверке склада, через месяц.
//
// HOLDINGS_FIRST_V1 — откуда берётся доза у койки, решает ОДНА цепочка
// (holdingChain выше), общая с амбулаторией, и решает её ВСЕГДА: флага
// prefer_holdings больше нет. Он был опцией, и шесть дверей из восьми её не
// знали — именно поэтому выданное в палату списывалось со склада второй раз.
// Прежнее «только держатель, который покрывает дозу целиком» тоже ушло:
// покрытие бывает частичным.
export function dispenseAdmissionItemCore(db, args, user) {
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
    // решает вызывающий (DISPENSE_ROLES у консоли койки, MARK_ROLES у листа
    // назначений); эта строка отвечает только на вопрос «дошёл ли пациент до
    // лечения».
    const adm = assertAdmissionAtLeast(db, admissionId, 'active');
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new RpcError('product not found.', 400);
    if (!product.active) throw new RpcError('product is not active.', 400);

    // HOLDINGS_FIRST_V1 — свой подотчёт → свой кабинет → отдел палаты → свой
    // отдел → склад. Не хватило нигде — отказ со словами, до первой записи.
    const picks = planSources(db, holdingChain(db, user, { admission: adm }), product, quantity);
    // EXPIRY_BALANCE_V1 — та же тревога у койки, что и в амбулатории.
    const warnings = expiryWarnings(db, [productId]);

    // Строка счёта — БЕЗ ИЗМЕНЕНИЙ: цена из каталога, billable как прислали.
    const unitPrice = product.sale_price;
    const total = round2(unitPrice * quantity);
    const info = db.prepare(`
      INSERT INTO admission_services (admission_id, clinic_item_id, service_id, doctor_id, bed_id, ward_id, quantity, unit_price, total, status, billable, notes, performed_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'added', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    `).run(admissionId, productId, doctorId, adm.bed_id, adm.ward_id, quantity, unitPrice, total, billable ? 1 : 0, note);

    applySources(db, picks, productId, user, 'admission', info.lastInsertRowid);

    const fresh = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(productId);
    return { line_id: info.lastInsertRowid, item_name: product.name, on_hand: fresh.on_hand, sources: picks, warnings };
  });
  return run();
}

export function voidDispensedAdmissionItem(db, args, user) {
  requireRole(user, VOID_ROLES);
  return voidDispensedAdmissionItemCore(db, args, user);
}

// MED_ADMIN_CHARGE_V1 — возврат без вопроса о роли; парная к
// dispenseAdmissionItemCore и заведена по той же причине (см. её комментарий).
// Снятие отметки о введении делает СТАРШАЯ МЕДСЕСТРА, а её нет в VOID_ROLES —
// и не должно быть: чужую выдачу у койки она не отменяет.
export function voidDispensedAdmissionItemCore(db, args, user) {
  const lineId = args && args.line_id;
  if (!isPositiveInt(lineId)) throw new RpcError('line_id must be a positive integer.', 400);

  const run = db.transaction(() => {
    const line = db.prepare('SELECT * FROM admission_services WHERE id = ?').get(lineId);
    if (!line) throw new RpcError('line not found.', 400);
    if (line.clinic_item_id == null) throw new RpcError('not a dispensed line.', 400);
    if (line.invoice_item_id != null) throw new RpcError('cannot void an invoiced line.', 400);

    // HOLDINGS_FIRST_V1 — каждая часть возвращается СВОЕМУ источнику: движения
    // этой строки называют их все, а не только последний.
    const parts = restoreSources(db, 'admission', lineId, line.clinic_item_id, line.quantity, user);
    db.prepare('DELETE FROM admission_services WHERE id = ?').run(lineId);

    const fresh = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(line.clinic_item_id);
    return { product_id: line.clinic_item_id, on_hand: fresh ? fresh.on_hand : null, sources: parts };
  });
  return run();
}
