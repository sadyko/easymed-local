// STOCK_REQUEST_V1 (2026-09-23) — ЗАЯВКА СЕБЕ ИЛИ ОТДЕЛУ И АВТОЗАЯВКА ПО МИНИМУМУ.
//
// Владелец: «#my-stock should be able to request and set to auto request with
// minimum amount». План: docs/plans/2026-09-23-stock-requests.md. Решения
// владельца (рекомендованный вариант в каждом из четырёх вопросов):
//
//   1. СКОЛЬКО ПРОСИТ АВТОЗАЯВКА — до нормы. На держателя и товар два числа,
//      минимум и норма. Остаток упал ниже минимума → заявка на
//      (норма − остаток − уже запрошено и не выдано), не меньше нуля,
//      округлённая вверх до целой единицы расхода (таблетки, а не 0.37 уп).
//   2. КТО ОДОБРЯЕТ — кладовщик в «Заявках», как любую заявку; одобрение
//      выдаёт (procurement.js approveRequisitionAndIssue). Автозаявка сама
//      ничего не двигает — она только подаётся.
//   3. ДЛЯ КОГО — человек просит себе; член отдела (или его заведующая) —
//      для отдела.
//   4. КТО СТАВИТ МИНИМУМ — каждый себе, заведующая — отделу, кладовщик и
//      администратор (или роль с правом «Закупки: изменение») — любому.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ. Автозаявку зовёт holdings.js moveHolding — ЕДИНСТВЕННОЕ
// место, где пишется stock_holdings (его зовут склад, одобрение заявки,
// цепочка списания inventory.js и дверь медсестры). procurement.js сам
// импортирует holdings.js, поэтому живи общее ядро заявки там, получился бы
// круг holdings → procurement → holdings. Здесь круга нет: этот файл не
// импортирует ни holdings.js, ни procurement.js, а оба берут ядро отсюда.
//
// ЕДИНИЦЫ. Минимум, норма, остаток и строки заявки — БАЗОВЫЕ единицы товара,
// те же, что stock_holdings.qty и products.on_hand. Экран может прислать число
// в единицах расхода (`unit: 'consumption'`), сервер переводит его сам — тем
// же consumption_factor, что «Выдать со склада».
import { hasAnyRole } from '../roles.js';
import { grantAllowsOr } from '../grants.js';
import { logDepartmentEvent } from './departments.js';
import { canSeeAllMovements } from './stock-log.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

/** Кто подаёт заявку на склад — тот же список, что был у create_requisition. */
export const REQUISITION_ROLES = ['admin', 'inventory', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];
const MANAGE_ALL_ROLES = ['admin', 'inventory'];
export const REQUEST_HOLDER_TYPES = ['staff', 'department'];
const OPEN_STATUSES = ['draft', 'submitted', 'approved'];
const UNITS = ['base', 'consumption'];
const MAX_QTY = 1_000_000;
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

const isPosInt = (v) => Number.isInteger(v) && v > 0;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const num = (v) => String(round2(v));

function factorOf(product) {
  return product && product.consumption_unit && Number(product.consumption_factor) > 0 ? Number(product.consumption_factor) : 1;
}
function unitLabel(product) {
  return (product && (product.consumption_unit || product.base_unit || product.unit)) || '';
}

// --- Общее ядро заявки --------------------------------------------------------

/**
 * Строки заявки из того, что прислал экран: товар, количество, заметка.
 * Слова отказа — те же, что были у create_requisition.
 */
export function parseRequisitionLines(rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw new RpcError('Добавьте хотя бы одну позицию.', 400);
  return rawLines.map((l) => {
    const productId = l ? Number(l.item_id ?? l.product_id) : NaN;
    const qty = l ? Number(l.qty) : NaN;
    if (!isPosInt(productId)) throw new RpcError('Позиция заявки: товар не выбран.', 400);
    if (!(Number.isFinite(qty) && qty > 0 && qty <= MAX_QTY)) throw new RpcError('Позиция заявки: количество должно быть больше нуля.', 400);
    const note = l && typeof l.note === 'string' ? l.note.trim().slice(0, 200) : '';
    const unit = l && l.unit !== undefined && l.unit !== null ? l.unit : 'base';
    return { productId, qty: round2(qty), note, unit };
  });
}

/**
 * Записать поданную заявку: номер REQ-ГГГГММДД-NNN, держатель, строки в
 * базовых единицах, запись в журнал отдела. Одно место на ручную заявку
 * отдела (create_requisition), заявку себе/отделу (stock_request_create) и
 * автозаявку. Зовётся ВНУТРИ транзакции вызывающего.
 * holder: { type: 'staff'|'department', id } или null (выдача без держателя).
 */
export function insertRequisition(db, { holder, notes, lines, userId, auto = false }) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const n = db.prepare('SELECT COUNT(*) AS n FROM purchase_requisitions WHERE req_number LIKE ?').get(`REQ-${day}-%`).n + 1;
  const reqNumber = `REQ-${day}-${String(n).padStart(3, '0')}`;
  const departmentId = holder && holder.type === 'department' ? holder.id : null;
  const reqId = Number(db.prepare(`
    INSERT INTO purchase_requisitions (req_number, status, department_id, notes, requested_by, holder_type, holder_id, auto)
    VALUES (?, 'submitted', ?, ?, ?, ?, ?, ?)`)
    .run(reqNumber, departmentId, notes || null, userId || null, holder ? holder.type : null, holder ? holder.id : null, auto ? 1 : 0)
    .lastInsertRowid);
  const ins = db.prepare('INSERT INTO purchase_requisition_items (req_id, product_id, qty, note) VALUES (?, ?, ?, ?)');
  for (const l of lines) ins.run(reqId, l.productId, l.qty, l.note || null);
  if (departmentId) {
    const details = { req_id: reqId, req_number: reqNumber, lines: lines.length };
    if (auto) details.auto = true;
    logDepartmentEvent(db, departmentId, 'requisition_created', userId || null, details);
  }
  return { req_id: reqId, req_number: reqNumber, status: 'submitted' };
}

// --- Права (решения 3 и 4) ----------------------------------------------------

/** Кладовщик, администратор или роль с правом «Закупки: изменение» — любому. */
function canManageAll(db, user) {
  if (!user) return false;
  return grantAllowsOr(db, user, 'procurement', 'edit', () => hasAnyRole(user, MANAGE_ALL_ROLES));
}

function ownDepartmentId(db, userId) {
  const row = db.prepare('SELECT department_id FROM users WHERE id = ?').get(userId);
  return row && isPosInt(Number(row.department_id)) ? Number(row.department_id) : null;
}

function headedDepartments(db, userId) {
  return db.prepare('SELECT id FROM departments WHERE head_user_id = ? ORDER BY id').all(userId).map((r) => r.id);
}

/** Ставить минимум этому держателю: себе, отделу, которым руководишь, или любому. */
function canSetFor(db, user, holder, manageAll) {
  if (manageAll) return true;
  const uid = Number(user && user.id);
  if (!isPosInt(uid)) return false;
  if (holder.type === 'staff') return holder.id === uid;
  return !!db.prepare('SELECT 1 FROM departments WHERE id = ? AND head_user_id = ?').get(holder.id, uid);
}

function parseHolder(db, a) {
  const type = a && typeof a.holder_type === 'string' ? a.holder_type : '';
  if (!REQUEST_HOLDER_TYPES.includes(type)) throw new RpcError('Минимум ставится сотруднику или отделу.', 400);
  const id = Number(a.holder_id);
  if (!isPosInt(id)) throw new RpcError('Не выбрано, кому ставится минимум.', 400);
  const row = type === 'staff'
    ? db.prepare('SELECT id, full_name AS name FROM users WHERE id = ?').get(id)
    : db.prepare('SELECT id, name FROM departments WHERE id = ?').get(id);
  if (!row) throw new RpcError(type === 'staff' ? 'Сотрудник не найден.' : 'Отдел не найден.', 404);
  return { type, id, name: row.name || '' };
}

function loadProduct(db, productId) {
  if (!isPosInt(productId)) throw new RpcError('Товар не выбран.', 400);
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!p) throw new RpcError('Товар не найден.', 404);
  return p;
}

function requireSetter(db, user, holder) {
  if (canSetFor(db, user, holder, canManageAll(db, user))) return;
  throw new RpcError('Минимум можно ставить себе, а отделу — его заведующей. Любому — кладовщик или администратор.', 403);
}

// --- Автозаявка ---------------------------------------------------------------

function heldQty(db, holder, productId) {
  const r = db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(holder.type, holder.id, productId);
  return r ? Number(r.qty) : 0;
}

const OPEN_IN = OPEN_STATUSES.map((s) => `'${s}'`).join(', ');

/** Сколько этому держателю уже запрошено этого товара и ещё не выдано. */
function openRequestedQty(db, holder, productId) {
  return Number(db.prepare(`
    SELECT COALESCE(SUM(i.qty), 0) AS q
      FROM purchase_requisitions r JOIN purchase_requisition_items i ON i.req_id = r.id
     WHERE r.holder_type = ? AND r.holder_id = ? AND i.product_id = ? AND r.status IN (${OPEN_IN})`)
    .get(holder.type, holder.id, productId).q) || 0;
}

function openAutoRequest(db, holder, productId) {
  return db.prepare(`
    SELECT r.id FROM purchase_requisitions r JOIN purchase_requisition_items i ON i.req_id = r.id
     WHERE r.holder_type = ? AND r.holder_id = ? AND i.product_id = ? AND r.auto = 1 AND r.status IN (${OPEN_IN})
     LIMIT 1`).get(holder.type, holder.id, productId);
}

/**
 * Проверка минимума: остаток ниже минимума и открытой автозаявки на этот
 * товар у этого держателя нет → подаётся заявка до нормы. Возвращает
 * { req_id, req_number, qty } или null. Бросает — зовущий решает, что с этим
 * делать (списание глушит, установка минимума показывает).
 */
export function autoRequestCheck(db, holder, productId, actorId) {
  if (!holder || !REQUEST_HOLDER_TYPES.includes(holder.type)) return null;
  const min = db.prepare('SELECT min_qty, target_qty FROM stock_minimums WHERE holder_type = ? AND holder_id = ? AND product_id = ?')
    .get(holder.type, holder.id, productId);
  if (!min) return null;
  const remaining = heldQty(db, holder, productId);
  if (!(remaining + 1e-9 < Number(min.min_qty))) return null;
  if (openAutoRequest(db, holder, productId)) return null;   // одно пересечение — одна заявка
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return null;
  const need = Number(min.target_qty) - remaining - openRequestedQty(db, holder, productId);
  if (!(need > 1e-9)) return null;
  // Вверх до целой единицы расхода. Округление до миллионных перед ceil —
  // иначе (5 − 1.7) × 10 = 33.000000000000004 превращалось бы в 34 таблетки.
  const cf = factorOf(product);
  const units = Math.ceil(Math.round(need * cf * 1e6) / 1e6);
  const qty = round2(units / cf);
  if (!(qty > 0)) return null;
  const unit = unitLabel(product);
  const note = `Автозаявка: остаток ${num(remaining * cf)} ${unit} при минимуме ${num(Number(min.min_qty) * cf)} ${unit}`
    .replace(/\s+/g, ' ').trim();
  const res = insertRequisition(db, {
    holder, notes: note, userId: isPosInt(Number(actorId)) ? Number(actorId) : null, auto: true,
    lines: [{ productId, qty, note: null }],
  });
  return { req_id: res.req_id, req_number: res.req_number, qty };
}

/**
 * Зовётся holdings.js moveHolding ПОСЛЕ того, как остаток держателя
 * уменьшился. Никогда не бросает в списание: поломка автозаявки — не повод
 * отказать пациенту. Работает внутри транзакции списания (вложенная
 * транзакция better-sqlite3 — это SAVEPOINT): откатилось списание — пропала и
 * заявка; сломалась заявка на полпути — откатывается только она, а не
 * списание, и полузаявки без строк в базе не остаётся.
 */
export function afterHoldingDecrease(db, holder, productId, actorId) {
  if (!holder || !REQUEST_HOLDER_TYPES.includes(holder.type)) return null;
  try {
    return db.transaction(() => autoRequestCheck(db, holder, productId, actorId))();
  } catch (e) {
    console.warn('[stock-requests] автозаявка не подана:', holder.type, holder.id, 'товар', productId, '—', e && e.message);
    return null;
  }
}

// --- RPC ----------------------------------------------------------------------

function readAmount(v, what) {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n < 0 || n > MAX_QTY) {
    throw new RpcError(`${what}: число от 0 до ${MAX_QTY}.`, 400);
  }
  return n;
}

/**
 * stock_minimum_set — поставить или поправить минимум и норму.
 * args: { holder_type: 'staff'|'department', holder_id, product_id, min_qty, target_qty,
 *         unit?: 'base' (по умолчанию) | 'consumption' }
 * → { minimum: { holder_type, holder_id, product_id, min_qty, target_qty, set_by, updated_at },
 *     request: { req_id, req_number, qty } | null }   — qty и минимумы в БАЗОВЫХ единицах
 * После установки — та же проверка, что после списания: минимум выше остатка
 * подаёт заявку сразу.
 */
export function stockMinimumSet(db, args, user) {
  const a = args || {};
  const unit = a.unit === undefined || a.unit === null ? 'base' : a.unit;
  if (!UNITS.includes(unit)) throw new RpcError('Единица: базовая или единица расхода.', 400);
  let minQ = readAmount(a.min_qty, 'Минимум');
  let targetQ = readAmount(a.target_qty, 'Норма');
  const run = db.transaction(() => {
    const holder = parseHolder(db, a);
    const product = loadProduct(db, Number(a.product_id));
    requireSetter(db, user, holder);
    if (unit === 'consumption') {
      const cf = factorOf(product);
      minQ = round2(minQ / cf);
      targetQ = round2(targetQ / cf);
    } else {
      minQ = round2(minQ);
      targetQ = round2(targetQ);
    }
    if (targetQ + 1e-9 < minQ) throw new RpcError('Норма не может быть меньше минимума.', 400);
    db.prepare(`
      INSERT INTO stock_minimums (holder_type, holder_id, product_id, min_qty, target_qty, set_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ${NOW})
      ON CONFLICT (holder_type, holder_id, product_id) DO UPDATE SET
        min_qty = excluded.min_qty, target_qty = excluded.target_qty,
        set_by = excluded.set_by, updated_at = excluded.updated_at`)
      .run(holder.type, holder.id, product.id, minQ, targetQ, isPosInt(Number(user && user.id)) ? Number(user.id) : null);
    const minimum = { ...db.prepare(`
      SELECT holder_type, holder_id, product_id, min_qty, target_qty, set_by, updated_at
        FROM stock_minimums WHERE holder_type = ? AND holder_id = ? AND product_id = ?`).get(holder.type, holder.id, product.id) };
    const request = autoRequestCheck(db, holder, product.id, user && user.id);
    return { minimum, request };
  });
  return run();
}

/**
 * stock_minimum_clear — снять минимум. Права те же, что у установки.
 * args: { holder_type, holder_id, product_id } → { ok: true, removed: 0|1 }
 * Уже поданная автозаявка остаётся: её судьбу решает кладовщик в «Заявках».
 */
export function stockMinimumClear(db, args, user) {
  const a = args || {};
  const run = db.transaction(() => {
    const holder = parseHolder(db, a);
    const productId = Number(a.product_id);
    if (!isPosInt(productId)) throw new RpcError('Товар не выбран.', 400);
    requireSetter(db, user, holder);
    const r = db.prepare('DELETE FROM stock_minimums WHERE holder_type = ? AND holder_id = ? AND product_id = ?')
      .run(holder.type, holder.id, productId);
    return { ok: true, removed: r.changes };
  });
  return run();
}

const LIST_SCOPES = ['mine', 'department', 'all'];

/**
 * stock_minimums_list — минимумы с остатком на руках и открытой заявкой.
 * args: { scope?: 'mine' (по умолчанию) | 'department' | 'all', department_id? }
 *   mine       — мои личные минимумы;
 *   department — отделов, где я состою или которыми руковожу (department_id
 *                сужает до одного из них; кладовщику и администратору — любой);
 *   all        — вся клиника, только тем, кто видит весь склад.
 * → { scope, can_manage_all, rows: [{ holder_type, holder_id, holder_name,
 *      product_id, product_name, base_unit, consumption_unit, consumption_factor,
 *      held_qty, held_units, min_qty, min_units, target_qty, target_units, below_min,
 *      set_by, set_by_name, updated_at, can_edit,
 *      open_qty, open_request: { req_id, req_number, status, qty, auto } | null }] }
 * *_qty — базовые единицы, *_units — единицы расхода.
 */
export function stockMinimumsList(db, args, user) {
  const a = args || {};
  const uid = Number(user && user.id);
  if (!isPosInt(uid)) throw new RpcError('Вошедший не опознан.', 401);
  const scope = a.scope === undefined || a.scope === null || a.scope === '' ? 'mine' : a.scope;
  if (!LIST_SCOPES.includes(scope)) throw new RpcError(`Неизвестная область: ${scope}.`, 400);
  const manageAll = canManageAll(db, user);
  const seeAll = manageAll || canSeeAllMovements(db, user);

  let where; let params;
  if (scope === 'mine') {
    where = "m.holder_type = 'staff' AND m.holder_id = ?"; params = [uid];
  } else if (scope === 'all') {
    if (!seeAll) throw new RpcError('Минимумы всей клиники видят кладовщик и администратор.', 403);
    where = '1 = 1'; params = [];
  } else {
    const own = new Set(headedDepartments(db, uid));
    const mine = ownDepartmentId(db, uid);
    if (mine) own.add(mine);
    let ids = [...own];
    if (a.department_id !== undefined && a.department_id !== null && a.department_id !== '') {
      const d = Number(a.department_id);
      if (!isPosInt(d)) throw new RpcError('Отдел не выбран.', 400);
      if (!own.has(d) && !seeAll) throw new RpcError('Минимумы чужого отдела недоступны: видны свой отдел и отдел, которым вы руководите.', 403);
      ids = [d];
    }
    if (!ids.length) return { scope, can_manage_all: manageAll, rows: [] };
    where = `m.holder_type = 'department' AND m.holder_id IN (${ids.map(() => '?').join(', ')})`;
    params = ids;
  }

  const rows = db.prepare(`
    SELECT m.holder_type, m.holder_id, m.product_id, m.min_qty, m.target_qty, m.set_by, m.updated_at,
           p.name AS product_name, p.base_unit, p.unit, p.consumption_unit, p.consumption_factor,
           COALESCE((SELECT h.qty FROM stock_holdings h WHERE h.holder_type = m.holder_type AND h.holder_id = m.holder_id AND h.product_id = m.product_id), 0) AS held,
           CASE m.holder_type WHEN 'staff' THEN (SELECT full_name FROM users WHERE id = m.holder_id)
                              ELSE (SELECT name FROM departments WHERE id = m.holder_id) END AS holder_name,
           (SELECT full_name FROM users WHERE id = m.set_by) AS set_by_name
      FROM stock_minimums m JOIN products p ON p.id = m.product_id
     WHERE ${where}
     ORDER BY m.holder_type DESC, holder_name, m.holder_id, p.name`).all(...params);

  const lastOpen = db.prepare(`
    SELECT r.id, r.req_number, r.status, r.auto, i.qty
      FROM purchase_requisitions r JOIN purchase_requisition_items i ON i.req_id = r.id
     WHERE r.holder_type = ? AND r.holder_id = ? AND i.product_id = ? AND r.status IN (${OPEN_IN})
     ORDER BY r.id DESC LIMIT 1`);

  return {
    scope, can_manage_all: manageAll,
    rows: rows.map((r) => {
      const holder = { type: r.holder_type, id: r.holder_id };
      const cf = factorOf(r);
      const open = lastOpen.get(r.holder_type, r.holder_id, r.product_id);
      return {
        holder_type: r.holder_type, holder_id: r.holder_id, holder_name: r.holder_name || '',
        product_id: r.product_id, product_name: r.product_name,
        base_unit: r.base_unit || r.unit || '', consumption_unit: r.consumption_unit || r.base_unit || r.unit || '', consumption_factor: cf,
        held_qty: round2(r.held), held_units: round2(r.held * cf),
        min_qty: round2(r.min_qty), min_units: round2(r.min_qty * cf),
        target_qty: round2(r.target_qty), target_units: round2(r.target_qty * cf),
        below_min: r.held + 1e-9 < r.min_qty,
        set_by: r.set_by, set_by_name: r.set_by_name || '', updated_at: r.updated_at,
        can_edit: canSetFor(db, user, holder, manageAll),
        open_qty: round2(openRequestedQty(db, holder, r.product_id)),
        open_request: open ? { req_id: open.id, req_number: open.req_number, status: open.status, qty: round2(open.qty), auto: !!open.auto } : null,
      };
    }),
  };
}

/**
 * stock_request_create — заявка на склад себе или своему отделу.
 * args: { for: 'me' | 'department', department_id?, notes?,
 *         lines: [{ product_id, qty, unit?: 'base' (по умолчанию) | 'consumption', note? }] }
 * 'department' без department_id — свой отдел (users.department_id).
 * → { req_id, req_number, status: 'submitted', holder_type, holder_id }
 */
export function stockRequestCreate(db, args, user) {
  if (!hasAnyRole(user, REQUISITION_ROLES)) {
    throw new RpcError('Подавать заявки на склад вашей роли нельзя.', 403);
  }
  const a = args || {};
  const uid = Number(user && user.id);
  if (!isPosInt(uid)) throw new RpcError('Вошедший не опознан.', 401);
  if (a.for !== 'me' && a.for !== 'department') throw new RpcError('Укажите, для кого заявка: себе или отделу.', 400);
  const notes = typeof a.notes === 'string' ? a.notes.trim().slice(0, 500) : '';
  const lines = parseRequisitionLines(a.lines);
  for (const l of lines) {
    if (!UNITS.includes(l.unit)) throw new RpcError('Позиция заявки: единица — базовая или единица расхода.', 400);
  }

  const run = db.transaction(() => {
    let holder;
    if (a.for === 'me') {
      holder = { type: 'staff', id: uid };
    } else {
      const own = ownDepartmentId(db, uid);
      const wanted = a.department_id === undefined || a.department_id === null || a.department_id === '' ? own : Number(a.department_id);
      if (!isPosInt(wanted)) throw new RpcError('Выберите отдел, для которого запрашиваются товары.', 400);
      if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(wanted)) throw new RpcError('Отдел не найден.', 404);
      const heads = !!db.prepare('SELECT 1 FROM departments WHERE id = ? AND head_user_id = ?').get(wanted, uid);
      if (wanted !== own && !heads) {
        throw new RpcError('Просить для отдела можно только для своего — где вы работаете или которым руководите.', 403);
      }
      holder = { type: 'department', id: wanted };
    }
    const base = lines.map((l) => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(l.productId);
      if (!product) throw new RpcError('Товар заявки не найден.', 404);
      const qty = l.unit === 'consumption' ? round2(l.qty / factorOf(product)) : l.qty;
      if (!(qty > 0)) throw new RpcError(`Позиция заявки: слишком мало — ${product.name}.`, 400);
      return { productId: l.productId, qty, note: l.note };
    });
    const res = insertRequisition(db, { holder, notes, lines: base, userId: uid });
    return { ...res, holder_type: holder.type, holder_id: holder.id };
  });
  return run();
}

/**
 * stock_requests_mine — «Мои заявки» на экране «Мои запасы» (R2): открытые
 * заявки, поданные МНЕ (держатель — я) и поданные МНОЙ для отдела. Только
 * чтение. Строки — в единицах расхода, как человек и просил.
 * args: {} → { rows: [{ req_id, req_number, status, auto, created_at, notes,
 *   holder_type, holder_id, holder_name,
 *   lines: [{ product_id, product_name, qty, units, unit }] }] }   — qty базовые, units — расхода
 */
export function stockRequestsMine(db, _args, user) {
  const uid = Number(user && user.id);
  if (!isPosInt(uid)) throw new RpcError('Вошедший не опознан.', 401);
  const reqRows = db.prepare(`
    SELECT r.id, r.req_number, r.status, r.auto, r.created_at, r.notes, r.holder_type, r.holder_id,
           CASE r.holder_type WHEN 'staff' THEN (SELECT full_name FROM users WHERE id = r.holder_id)
                              ELSE (SELECT name FROM departments WHERE id = r.holder_id) END AS holder_name
      FROM purchase_requisitions r
     WHERE r.status IN (${OPEN_IN})
       AND ((r.holder_type = 'staff' AND r.holder_id = ?) OR (r.holder_type = 'department' AND r.requested_by = ?))
     ORDER BY r.id DESC LIMIT 100`).all(uid, uid);
  const items = db.prepare(`
    SELECT i.product_id, i.qty, p.name AS product_name, p.base_unit, p.unit, p.consumption_unit, p.consumption_factor
      FROM purchase_requisition_items i LEFT JOIN products p ON p.id = i.product_id
     WHERE i.req_id = ? ORDER BY i.id`);
  return {
    rows: reqRows.map((r) => ({
      req_id: r.id, req_number: r.req_number, status: r.status, auto: !!r.auto, created_at: r.created_at,
      notes: r.notes || '', holder_type: r.holder_type, holder_id: r.holder_id, holder_name: r.holder_name || '',
      lines: items.all(r.id).map((i) => ({
        product_id: i.product_id, product_name: i.product_name || '',
        qty: round2(i.qty), units: round2(Number(i.qty) * factorOf(i)), unit: unitLabel(i),
      })),
    })),
  };
}
