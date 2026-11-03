// ═══════════════════════════════════════════════════════════════════════════
// DUP_STOP_V1 (2026-11-02) — ЖЁСТКИЙ ЗАПРЕТ ПОВТОРНОГО НАЗНАЧЕНИЯ В ОДНОМ ВИЗИТЕ
// ═══════════════════════════════════════════════════════════════════════════
//
// Правило «та же услуга» — public/js/shared/dup-order.js (orderKey). Здесь — что
// считается уже назначенным, слова отказа, обход с причиной и журнал.
//
// УЖЕ НАЗНАЧЕНО — строка того же визита, которая:
//   • не отменена (status <> 'cancelled');
//   • не товар (clinic_item_id пуст) и не процедура (services.type = 'procedure');
//   • не отпущена со счёта с возвратом (отметка 'out' в pay_refund_releases при
//     пустой ссылке на счёт — то же условие, что refundedOpenLineIds, REFUND_ANY_V1).
// Строки, которые дверь сама уберёт под новой (замена записи колл-центра — R7b,
// crm/booked-twin.js; строка CRM уступает строке человека — crm/one-way.js),
// вызывающий передаёт в spare: они не мешают.
//
// ОБХОД. Администратор и главный врач назначают повтор с причиной (≥ 3 знаков):
// /api/db — полем __repeat_reason строки (снимается до compile(), как __notes_base),
// RPC — аргументом __repeat_reason. Каждый обход — строка invoice_audit_log
// (action 'line_repeat_order': журнал правок строк, его не считают «работой визита»
// — discard_empty_visit пропускает line_*). Не бросает ничего, кроме отказа.
//
// ДЛЯ ДРУГИХ ДВЕРЕЙ (U8 calendar_book, U10 и далее): новая вставка строки визита зовёт
//   const orders = assertOrders(db, [{ visit_id, service_id | consultation_type_id, doctor_id }],
//                               { user, reason: repeatReasonArg(args) });
//   …вставка…
//   logRepeatOrders(db, orders, user);
// в той же транзакции, что и вставка.
import { hasAnyRole } from '../roles.js';
import { actingActorName } from '../../../public/js/shared/act-as.js';
import { fillTemplate } from '../server-message.js';
import {
  orderKey, repeatableLine, repeatReasonOk, REPEAT_REASON_KEY, REPEAT_REASON_MAX, REPEAT_ROLES,
  DUP_TEMPLATE_BILLED, DUP_TEMPLATE_UNBILLED, DUP_TEMPLATE_TWICE, DUP_TEMPLATE_PLAIN,
} from '../../../public/js/shared/dup-order.js';

export const DUP_CODE = 'duplicate_order';

export class DuplicateOrderError extends Error {
  constructor({ template, params, existing = null, index = 0 }) {
    super(fillTemplate(template, params));
    this.status = 409;
    this.code = DUP_CODE;
    this.template = template;
    this.params = params;
    this.existing = existing;
    this.index = index;
  }
}

const pos = (v) => (v != null && v !== '' && typeof v !== 'boolean' && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** Живые назначения визита (см. шапку) с тем, что нужно словам отказа. */
export function liveOrders(db, visitId) {
  const id = pos(visitId);
  if (id == null) return [];
  return db.prepare(`
    SELECT vs.id, vs.visit_id, vs.service_id, vs.consultation_type_id, vs.doctor_id, vs.status,
           vs.invoice_item_id, vs.created_by, vs.created_at,
           s.type AS service_type, s.name AS service_name, s.requires_doctor AS service_requires_doctor,
           COALESCE(ct.name_ru, ct.name) AS consultation_name,
           u.full_name AS creator_name, d.full_name AS doctor_name,
           strftime('%d.%m.%Y %H:%M', vs.created_at, 'localtime') AS created_local,
           i.id AS invoice_id, i.invoice_number
      FROM visit_services vs
      LEFT JOIN services s ON s.id = vs.service_id
      LEFT JOIN consultation_types ct ON ct.id = vs.consultation_type_id
      LEFT JOIN users u ON u.id = vs.created_by
      LEFT JOIN users d ON d.id = vs.doctor_id
      LEFT JOIN invoice_items ii ON ii.id = vs.invoice_item_id
      LEFT JOIN invoices i ON i.id = ii.invoice_id
     WHERE vs.visit_id = ? AND vs.status <> 'cancelled' AND vs.clinic_item_id IS NULL
       AND COALESCE(s.type, '') <> 'procedure'
       AND NOT (vs.invoice_item_id IS NULL
                AND EXISTS (SELECT 1 FROM pay_refund_releases prr WHERE prr.kind = 'out' AND prr.line_id = vs.id))
     ORDER BY vs.id`).all(id);
}

const serviceTypeStmt = (db) => db.prepare('SELECT type, name, requires_doctor FROM services WHERE id = ?');

/**
 * Ключ строки базы (или строки запроса в форме базы). DUP_STOP_V1 (ревью m4) —
 * requiresDoctor (services.requires_doctor): врач в ключе — только у консультации,
 * которой нужен врач; у строки liveOrders он уже в service_requires_doctor.
 */
export function keyOfRow(row, serviceType = row && row.service_type, requiresDoctor = row && row.service_requires_doctor) {
  if (!row) return null;
  return orderKey({
    serviceId: row.service_id ?? null,
    consultationTypeId: row.service_id == null ? (row.consultation_type_id ?? null) : null,
    doctorId: row.doctor_id ?? null,
    serviceType: serviceType ?? null,
    requiresDoctor: requiresDoctor ?? null,
  });
}

/** Название назначения для отказа и журнала. */
function nameOf(db, row) {
  if (row.service_name) return row.service_name;
  if (row.consultation_name) return row.consultation_name;
  if (row.service_id != null) { const s = serviceTypeStmt(db).get(row.service_id); if (s) return s.name; }
  if (row.consultation_type_id != null) {
    const c = db.prepare('SELECT COALESCE(name_ru, name) AS n FROM consultation_types WHERE id = ?').get(row.consultation_type_id);
    if (c) return c.n;
  }
  return '—';
}

/**
 * Отказ по совпадению (для двери и для visit_dup_check). DUP_STOP_V1 (ревью M2) — plain:
 * без «кем, когда, счёт № …» и без номера строки — тем, кому строки визита и счета не
 * отдаются (patientDataRefusal): это данные пациента.
 */
export function refusalOf(db, hit, { plain = false } = {}) {
  if (hit.twice) {
    return new DuplicateOrderError({ template: DUP_TEMPLATE_TWICE, params: { service: nameOf(db, hit.line) }, index: hit.index });
  }
  const x = hit.existing;
  if (plain) return new DuplicateOrderError({ template: DUP_TEMPLATE_PLAIN, params: { service: nameOf(db, x) }, index: hit.index });
  const params = {
    service: nameOf(db, x),
    who: x.creator_name || '—',
    when: x.created_local || '—',
  };
  if (x.invoice_number) params.invoice = x.invoice_number;
  return new DuplicateOrderError({
    template: x.invoice_number ? DUP_TEMPLATE_BILLED : DUP_TEMPLATE_UNBILLED,
    params, existing: { id: x.id, invoice_number: x.invoice_number || null }, index: hit.index,
  });
}

/**
 * Совпадения строк запроса с уже назначенным и между собой.
 * @param {object} db
 * @param {Array<{visit_id:any, service_id?:any, consultation_type_id?:any, doctor_id?:any, clinic_item_id?:any}>} lines
 * @param {{excludeIds?:number[], spare?:(line:object)=>number[]}} [opts]
 *   excludeIds — строки, которые эта операция сама меняет (замена услуги: сама строка);
 *   spare — строки, которые дверь уберёт под этой строкой (R7b, строка CRM).
 * @returns {Array<{index:number, line:object, existing?:object, twice?:boolean}>}
 */
export function duplicateHits(db, lines, { excludeIds = [], spare = null } = {}) {
  const typeOf = serviceTypeStmt(db);
  const skip = new Set((excludeIds || []).map(Number));
  const seen = new Set();
  const live = new Map();
  const hits = [];
  (lines || []).forEach((line, index) => {
    if (!line) return;
    const visitId = pos(line.visit_id);
    if (visitId == null) return;
    const sid = pos(line.service_id);   // строка запроса: значение браузера — только целое число идёт в SQL
    const svc = sid != null ? typeOf.get(sid) : null;
    const serviceType = svc ? svc.type : null;
    if (repeatableLine({ clinicItemId: line.clinic_item_id ?? null, serviceType })) return;
    const key = keyOfRow(line, serviceType, svc ? svc.requires_doctor : null);   // DUP_STOP_V1 (ревью m4)
    if (!key) return;
    const own = visitId + '#' + key;
    if (seen.has(own)) { hits.push({ index, line, twice: true }); return; }
    seen.add(own);
    if (!live.has(visitId)) live.set(visitId, liveOrders(db, visitId));
    // DUP_STOP_V1 (ревью m8) — поблажки дверей (R7b, строка CRM: по нескольку запросов
    // каждая) спрашиваются, только когда в визите есть строка того же ключа: без неё
    // повтора нет, что бы дверь ни убрала.
    const same = live.get(visitId).filter((r) => !skip.has(Number(r.id)) && keyOfRow(r) === key);
    if (!same.length) return;
    const spared = new Set((spare ? spare(line) || [] : []).map(Number));
    const existing = same.find((r) => !spared.has(Number(r.id)));
    if (existing) hits.push({ index, line, existing });
  });
  return hits;
}

/** Обходить запрет может администратор и главный врач. */
export function canRepeatOrder(user) {
  return hasAnyRole(user, REPEAT_ROLES);
}

/**
 * Решение двери: { error } — отказ (DuplicateOrderError), { repeats } — обход с
 * причиной (журнал пишет logRepeatOrders ПОСЛЕ записи), {} — повторов нет.
 */
// DUP_STOP_V1 (ревью, остаток 2) — plain: отказ без «кем, когда, счёт № …» (см. refusalOf).
export function checkOrders(db, lines, { user = null, reason = null, excludeIds = [], spare = null, plain = false } = {}) {
  const hits = duplicateHits(db, lines, { excludeIds, spare });
  if (!hits.length) return {};
  if (canRepeatOrder(user) && repeatReasonOk(reason)) return { repeats: hits, reason: String(reason).trim().slice(0, REPEAT_REASON_MAX) };
  return { error: refusalOf(db, hits[0], { plain }), hits };
}

/** RPC: бросить отказ или вернуть обходы для журнала. */
export function assertOrders(db, lines, opts = {}) {
  const out = checkOrders(db, lines, opts);
  if (out.error) throw out.error;
  return out;
}

/** Журнал обхода: строка invoice_audit_log на каждое повторное назначение. */
export function logRepeatOrders(db, out, user) {
  if (!out || !out.repeats || !out.repeats.length) return 0;
  const actor = user && user.id != null ? db.prepare('SELECT id, full_name, role FROM users WHERE id = ?').get(user.id) : null;
  const ins = db.prepare(`INSERT INTO invoice_audit_log (invoice_id, invoice_number, visit_id, action, actor_user_id, actor_name, actor_role, reason, notes)
                          VALUES (?, ?, ?, 'line_repeat_order', ?, ?, ?, ?, ?)`);
  for (const h of out.repeats) {
    const x = h.existing || null;
    const name = nameOf(db, x || h.line);
    const before = x ? `${x.creator_name || '—'}, ${x.created_local || '—'}${x.invoice_number ? ', счёт № ' + x.invoice_number : ''}` : 'выбрана дважды в одном запросе';
    ins.run(x && x.invoice_id ? x.invoice_id : null, x && x.invoice_number ? x.invoice_number : null, Number(h.line.visit_id),
      actor ? actor.id : null, actor ? actingActorName(user, actor.full_name || null) : null, actor ? actor.role || null : null,
      out.reason, `Повторное назначение «${name}» (уже было: ${before})`);
  }
  return out.repeats.length;
}

/** /api/db: снять __repeat_reason со строк visit_services до compile(). */
export function takeRepeatReason(body) {
  if (!body || body.table !== 'visit_services') return null;
  const v = body.values;
  const rows = Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : []);
  let reason = null;
  for (const r of rows) {
    if (r && Object.prototype.hasOwnProperty.call(r, REPEAT_REASON_KEY)) {
      if (typeof r[REPEAT_REASON_KEY] === 'string' && r[REPEAT_REASON_KEY].trim()) reason = r[REPEAT_REASON_KEY];
      delete r[REPEAT_REASON_KEY];
    }
  }
  return reason;
}

/** RPC: причина обхода из аргументов. */
export function repeatReasonArg(args) {
  const r = args && args[REPEAT_REASON_KEY];
  return typeof r === 'string' && r.trim() ? r : null;
}

/**
 * Замена услуги или врача строки `before` на `after`: проверка — только если ключ
 * «та же услуга» меняется (новая услуга; у консультации — и новый врач). Сама строка
 * не мешает (excludeIds). Строки, задвоенные до 3.21.0, правке без смены ключа не мешают.
 */
// DUP_STOP_V1 (ревью, остаток 3) — spare: поблажка двери (строки, которые она уберёт под новой,
// как у assertOrders): возврат с новой услугой ставит НОВУЮ строку, и строка CRM той же
// услуги ей уступит (onVisitLinesAdded после операции).
export function assertChangedOrder(db, before, after, { user = null, reason = null, excludeIds = [], spare = null } = {}) {
  const typeOf = serviceTypeStmt(db);
  const svcOf = (row) => (row && row.service_id != null ? typeOf.get(row.service_id) || {} : {});
  const keyOf = (row) => { const s = svcOf(row); return keyOfRow(row, s.type || null, s.requires_doctor ?? null); };   // DUP_STOP_V1 (ревью m4)
  const was = keyOf(before);
  const now = keyOf(after);
  if (!now || now === was) return {};
  return assertOrders(db, [after], { user, reason, spare, excludeIds: [before.id, ...excludeIds].filter((x) => x != null) });
}

// DUP_STOP_V1 (ревью m2) — колонки строки, от которых зависит «та же услуга в том же визите».
export const ORDER_KEY_COLUMNS = Object.freeze(['visit_id', 'service_id', 'consultation_type_id', 'doctor_id']);

/** Правка строк визита задевает назначение: возвращает из отмены (status) или меняет ключ. */
export function updateTouchesOrders(values) {
  const v = values && typeof values === 'object' && !Array.isArray(values) ? values : null;
  if (!v) return false;
  const has = (k) => Object.prototype.hasOwnProperty.call(v, k);
  return ORDER_KEY_COLUMNS.some(has) || (has('status') && v.status !== 'cancelled');
}

/**
 * DUP_STOP_V1 (ревью m2) — ПРАВКА СТРОК ВИЗИТА ТАБЛИЧНЫМ ПУТЁМ (/api/db update). Строка,
 * которую возвращают из отмены (status 'cancelled' → другой), и строка, у которой меняется
 * ключ «та же услуга» (вид приёма; у консультации — врач; услуга; визит), — снова
 * назначение: проверка как у вставки, с поблажкой одной — правимые строки себе не повтор
 * (excludeIds), а друг другу — да («выбрана дважды»). Строки без смены ключа (статусы
 * работы, задвоенные до 3.21.0) не проверяются. Отменяющая правка не проверяется.
 * @param {Array<object>} rows — строки ДО правки (id, visit_id, service_id, consultation_type_id,
 *   doctor_id, status, clinic_item_id)
 * @param {object} values — значения правки
 * @returns то же, что checkOrders
 */
export function checkUpdatedOrders(db, rows, values, { user = null, reason = null, plain = false } = {}) {   // plain — DUP_STOP_V1 (ревью, остаток 2)
  if (!updateTouchesOrders(values)) return {};
  const v = values;
  const has = (k) => Object.prototype.hasOwnProperty.call(v, k);
  const typeOf = serviceTypeStmt(db);
  const keyOf = (row) => {
    const s = row && pos(row.service_id) != null ? typeOf.get(pos(row.service_id)) || {} : {};
    return keyOfRow(row, s.type || null, s.requires_doctor ?? null);
  };
  const moved = [];
  for (const r of rows || []) {
    if (!r) continue;
    const after = { ...r };
    for (const k of ORDER_KEY_COLUMNS) if (has(k)) after[k] = v[k];
    if (has('status')) after.status = v.status;
    if (after.status === 'cancelled') continue;
    const reopened = r.status === 'cancelled';
    if (reopened || keyOf(after) !== keyOf(r) || String(after.visit_id) !== String(r.visit_id)) moved.push(after);
  }
  if (!moved.length) return {};
  return checkOrders(db, moved, { user, reason, excludeIds: moved.map((r) => r.id), plain });
}
