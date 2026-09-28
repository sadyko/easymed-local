// OWN_SHELF_ONLY_V1 (ревью F6, 2026-09-28) — «НЕ СПИСАНО СО СКЛАДА».
//
// Владелец: «The dose is recorded, so the patient's chart is never blocked.
// The drug is marked «не списано со склада», and the warehouse sees it in a
// list to settle.»
//
// ОТКУДА СТРОКИ. Лист назначений (treatment-orders.js chargeAdministration)
// при ВКЛЮЧЁННОМ переключателе «Только со своих полок», когда дозы (или
// расхода сверх дозы) нет на полках медсестры. Отметка записана; пациенту
// начислено ОДИН РАЗ и ровно как при обычной выдаче — та же строка
// admission_services в момент отметки; с полок взято то, что на них было, а
// остаток лёг сюда (inventory.js dispenseAdmissionItemCore, pendingWhenShort).
//
//   stock_pending_list   — очередь склада: пациент, препарат, сколько, кто
//                          ввёл, когда, палата и койка; у каждой строки —
//                          откуда её можно списать (склад и полки, на которых
//                          этот товар лежит, и хватит ли там).
//   stock_pending_count  — сколько ждёт (бейдж «Закупок» и чип экрана).
//   stock_pending_settle — «Списать»: со склада или с выбранной полки, РОВНО
//                          ОДИН РАЗ, обычным движением журнала на ту же строку
//                          начисления (reference admission / id строки; строка
//                          помечена id отметки) — поэтому снятие отметки после
//                          списания возвращает товар обычным путём
//                          (inventory.js restoreSources).
//
// Деньги здесь не трогаются никогда: начислено при отметке, списание — только
// склад. Смотрит и списывает склад и администратор (WAREHOUSE_DISPENSE_ROLES).
import { hasAnyRole } from '../roles.js';
import { rpcT } from '../server-message.js';
import { applySources, WAREHOUSE_DISPENSE_ROLES } from './inventory.js';
import { WAREHOUSE, HOLDER_TYPES } from './holdings.js';
import { roundQty, factorOf, coversQty, unitsOf } from '../domain/stock-qty.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const STATUSES = ['pending', 'settled', 'cancelled'];
const isPosInt = (v) => Number.isInteger(v) && v > 0;

function requireWarehouse(user) {
  if (!user || !hasAnyRole(user, WAREHOUSE_DISPENSE_ROLES)) {
    throw new RpcError('«Не списано со склада» разбирают склад и администратор.', 403);
  }
}

const HOLDER_NAME_SQL = `CASE h.holder_type
    WHEN 'staff' THEN (SELECT full_name FROM users WHERE id = h.holder_id)
    WHEN 'room' THEN (SELECT name FROM rooms WHERE id = h.holder_id)
    ELSE (SELECT name FROM departments WHERE id = h.holder_id) END`;

/** Откуда можно списать: склад и полки с этим товаром — и хватит ли там. */
function sourcesFor(db, row) {
  const cf = factorOf(row);
  const need = roundQty(row.base_qty);
  const onHand = roundQty(row.on_hand);
  // Сколько там есть — в той же единице, что и доза в строке (ампулы, если
  // медсестра вводила ампулами): кладовщик сравнивает одно с одним.
  const inUnits = !!(row.consumption_unit && row.unit === row.consumption_unit && cf !== 1);
  const shown = (base) => (inUnits ? unitsOf(base, cf) : base);
  const out = [{ type: WAREHOUSE, id: null, name: '', qty: onHand, qty_shown: shown(onHand), enough: coversQty(onHand, need, cf) }];
  for (const h of db.prepare(`SELECT h.holder_type, h.holder_id, h.qty, ${HOLDER_NAME_SQL} AS name
                                FROM stock_holdings h
                               WHERE h.product_id = ? AND h.qty > 0
                               ORDER BY h.holder_type = 'staff' DESC, h.holder_type, name`).all(row.product_id)) {
    const qty = roundQty(h.qty);
    out.push({ type: h.holder_type, id: h.holder_id, name: h.name || '', qty, qty_shown: shown(qty), enough: coversQty(qty, need, cf) });
  }
  return out;
}

const LIST_SQL = `
  SELECT w.id, w.status, w.kind, w.base_qty, w.qty, w.unit, w.given_at, w.given_by,
         w.settled_at, w.settled_from_type, w.settled_from_id, w.cancelled_at, w.cancel_note,
         w.admission_service_id AS line_id, w.administration_id, w.admission_id, w.product_id,
         p.name AS product_name, p.on_hand, p.consumption_unit, p.consumption_factor,
         pt.full_name AS patient_name, pt.mrn,
         wd.name AS ward_name, b.code AS bed_code, dep.name AS department_name,
         gu.full_name AS given_by_name, su.full_name AS settled_by_name
    FROM stock_pending_writeoffs w
    JOIN products p ON p.id = w.product_id
    JOIN admissions a ON a.id = w.admission_id
    LEFT JOIN patients pt ON pt.id = a.patient_id
    LEFT JOIN admission_services s ON s.id = w.admission_service_id
    LEFT JOIN wards wd ON wd.id = COALESCE(s.ward_id, a.ward_id)
    LEFT JOIN departments dep ON dep.id = wd.department_id
    LEFT JOIN beds b ON b.id = COALESCE(s.bed_id, a.bed_id)
    LEFT JOIN users gu ON gu.id = w.given_by
    LEFT JOIN users su ON su.id = w.settled_by`;

/** stock_pending_list { status?: 'pending' | 'settled' | 'cancelled', limit? } */
export function stockPendingList(db, args, user) {
  requireWarehouse(user);
  const a = args || {};
  const status = a.status === undefined || a.status === null || a.status === '' ? 'pending' : a.status;
  if (!STATUSES.includes(status)) throw new RpcError('Неизвестное состояние списка.', 400);
  const limit = Number.isInteger(a.limit) && a.limit > 0 ? Math.min(a.limit, 500) : 200;
  const order = status === 'pending' ? 'w.given_at, w.id' : 'COALESCE(w.settled_at, w.cancelled_at) DESC, w.id DESC';
  const rows = db.prepare(`${LIST_SQL} WHERE w.status = ? ORDER BY ${order} LIMIT ?`).all(status, limit);
  return {
    status,
    count: status === 'pending' ? stockPendingCountRaw(db) : rows.length,
    rows: rows.map((r) => ({
      id: r.id, status: r.status, kind: r.kind, line_id: r.line_id,
      administration_id: r.administration_id, admission_id: r.admission_id,
      product_id: r.product_id, product_name: r.product_name,
      qty: r.qty, unit: r.unit, base_qty: r.base_qty,
      patient_name: r.patient_name || '', mrn: r.mrn || '',
      ward_name: r.ward_name || '', bed_code: r.bed_code || '', department_name: r.department_name || '',
      given_by_name: r.given_by_name || '', given_at: r.given_at,
      settled_by_name: r.settled_by_name || '', settled_at: r.settled_at,
      settled_from_type: r.settled_from_type, settled_from_id: r.settled_from_id,
      cancelled_at: r.cancelled_at, cancel_note: r.cancel_note || '',
      sources: r.status === 'pending' ? sourcesFor(db, r) : undefined,
    })),
  };
}

function stockPendingCountRaw(db) {
  return db.prepare("SELECT COUNT(*) n FROM stock_pending_writeoffs WHERE status = 'pending'").get().n;
}

/** stock_pending_count — сколько ждёт списания (бейдж). */
export function stockPendingCount(db, _args, user) {
  requireWarehouse(user);
  return { pending: stockPendingCountRaw(db) };
}

/** Отметка, у которой больше ничего не ждёт склада, снова «списано». */
function refreshAdministration(db, administrationId) {
  if (!administrationId) return;
  const left = db.prepare("SELECT COUNT(*) n FROM stock_pending_writeoffs WHERE administration_id = ? AND status = 'pending'").get(administrationId).n;
  if (left) return;
  const a = db.prepare('SELECT stock_status, stock_note FROM treatment_administrations WHERE id = ?').get(administrationId);
  if (!a || a.stock_status !== 'pending') return;
  db.prepare('UPDATE treatment_administrations SET stock_status = ?, stock_note = ? WHERE id = ?')
    .run('ok', `${a.stock_note ? `${a.stock_note} · ` : ''}списано складом`.slice(0, 1000), administrationId);
}

/**
 * stock_pending_settle { id, source: { type: 'warehouse' } | { type: 'staff'|'room'|'department', id } }
 * Ровно один раз: состояние проверяется и меняется в одной транзакции, и
 * второе нажатие (или второй кладовщик) слышит «уже списано».
 */
export function stockPendingSettle(db, args, user) {
  requireWarehouse(user);
  const a = args || {};
  const id = Number(a.id);
  if (!isPosInt(id)) throw new RpcError('Строка не выбрана.', 400);
  const src = a.source && typeof a.source === 'object' ? a.source : {};
  const type = src.type;
  if (type !== WAREHOUSE && !HOLDER_TYPES.includes(type)) throw new RpcError('Откуда списать: склад или полка.', 400);
  const holderId = type === WAREHOUSE ? null : Number(src.id);
  if (type !== WAREHOUSE && !isPosInt(holderId)) throw new RpcError('Полка не выбрана.', 400);

  const run = db.transaction(() => {
    const w = db.prepare('SELECT * FROM stock_pending_writeoffs WHERE id = ?').get(id);
    if (!w) throw new RpcError('Строка не найдена.', 404);
    if (w.status === 'settled') throw new RpcError('Уже списано.', 409);
    if (w.status === 'cancelled') throw new RpcError('Отметку сняли — списывать нечего.', 409);
    const line = db.prepare('SELECT id FROM admission_services WHERE id = ?').get(w.admission_service_id);
    if (!line) {
      // Строку начисления удалили мимо обычных путей (триггер мигр. 226 уже
      // закрыл бы запись) — списывать не за что.
      db.prepare(`UPDATE stock_pending_writeoffs SET status = 'cancelled', cancelled_at = ${NOW}, cancel_note = 'строка начисления удалена' WHERE id = ?`).run(id);
      throw new RpcError('Отметку сняли — списывать нечего.', 409);
    }
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(w.product_id);
    if (!product) throw new RpcError('Товар не найден.', 404);
    const cf = factorOf(product);
    const need = roundQty(w.base_qty);
    const unit = (w.unit || product.base_unit || product.unit || '').trim();
    const fmt = (base) => `${w.unit && w.unit !== (product.base_unit || product.unit) ? unitsOf(base, cf) : roundQty(base)} ${unit}`.trim();
    let have;
    let holderName = '';
    if (type === WAREHOUSE) {
      have = roundQty(product.on_hand);
    } else {
      const table = type === 'staff' ? 'users' : type === 'room' ? 'rooms' : 'departments';
      const who = db.prepare(`SELECT ${type === 'staff' ? 'full_name' : 'name'} AS name FROM ${table} WHERE id = ?`).get(holderId);
      if (!who) throw new RpcError('Полка не найдена.', 404);
      holderName = who.name || '';
      const row = db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(type, holderId, w.product_id);
      have = row ? roundQty(row.qty) : 0;
    }
    if (!coversQty(have, need, cf)) {
      throw rpcT(RpcError, 'Не хватает, чтобы списать: {name} — нужно {need}, есть {have}.', { name: product.name, need: fmt(need), have: fmt(have) }, 400);
    }
    const picks = [{ type: type === WAREHOUSE ? WAREHOUSE : type, id: holderId, qty: Math.min(have, need) }];
    applySources(db, picks, w.product_id, user, 'admission', w.admission_service_id,
      `не списано со склада — списано${w.administration_id ? ` (отметка #${w.administration_id})` : ''}`);
    const done = db.prepare(`UPDATE stock_pending_writeoffs
                                SET status = 'settled', settled_by = ?, settled_at = ${NOW},
                                    settled_from_type = ?, settled_from_id = ?
                              WHERE id = ? AND status = 'pending'`).run(user.id, type, holderId, id);
    if (done.changes !== 1) throw new RpcError('Уже списано.', 409);
    refreshAdministration(db, w.administration_id);
    return {
      id, status: 'settled', line_id: w.admission_service_id, administration_id: w.administration_id,
      source: { type, id: holderId, name: holderName }, qty: picks[0].qty,
    };
  });
  return run();
}
