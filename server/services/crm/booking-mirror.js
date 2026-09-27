// ═══════════════════════════════════════════════════════════════════════════
// CRM_CALENDAR_MIRROR_V1 (2026-09-27) — ЗАЯВКА И КАЛЕНДАРЬ — ОДНА ЗАПИСЬ
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: «they mirror each other, also the calendar. and the services —
// which means if in the CRM we create a booking it will show in the calendar.»
//
// Услуга записи живёт в двух таблицах: строка заявки (crm_request_services —
// её видит и правит колл-центр) и строка визита (visit_services — её видят
// календарь, окно визита, смета и касса). Пока пациент НЕ ПРИШЁЛ, это две
// стороны одного и того же: что добавили или сняли с одной стороны, появляется
// или исчезает на другой. Связь — crm_request_services.visit_service_id
// (миграция 187).
//
// ОДНО ПРАВИЛО, МНОГО ДВЕРЕЙ. mirrorVisit(db, visitId) — сверка одной записи,
// идемпотентная: зови сколько угодно раз, второй вызов не находит, что менять.
// Её зовут ВСЕ двери, которые пишут строки записи: ensure_visit, calendar_book,
// /api/db (visit_services и crm_request_services), remove_own_visit_line и RPC
// колл-центра booking_lines_add / booking_line_remove. Второго писателя в
// браузере нет и быть не должно (урок crm-lines.js closeCrmLines).
//
// ГРАНИЦА — ПРИХОД. Сверка работает только у записи ДО прихода: визит своего
// здания в статусе scheduled/confirmed. Строки визита она трогает только
// «свободные» — 'added', без счёта, без результатов и документов, не товар.
// Выставленное, оплаченное и начатое — история приёма; его правят касса и
// регистратура, а не заявка (правило «Пришёл» — crm/visit-status.js).
//
// НЕ БРОСАЕТ. Как и остальные хуки CRM: заявка не вправе отказать ни в записи,
// ни в строке сметы. Ошибка — в лог.

import { openStageKeys, scheduledStageKey, lostStageKeys, noShowStageKey } from './config.js';
import { localDate, today } from '../domain/day.js';
import { lineUnitPrice } from '../domain/pricing.js';
import { servicePriceQuote } from '../rpc/service-price-quote.js';
import { hasAnyRole } from '../roles.js';
import { EVIDENCE_SERVICE_STATUSES } from './visit-status.js';

/** Статусы визита, у которого пациент ещё не пришёл. Словарь — миграция 003. */
export const PRE_ARRIVAL = Object.freeze(['scheduled', 'confirmed']);

// Строки, которые держат строку визита: с ними она уже не «просто в смете».
// Тот же список, что у remove_own_visit_line (rpc/visit-lines.js).
const VS_CHILDREN = ['lab_results', 'visit_documents', 'lab_device_messages'];

// Котировку спрашивает сама система, а не человек: цена строки, заведённой
// зеркалом, — та же, что поставила бы регистратура (service_price_quote +
// lineUnitPrice, одно правило с кассой).
const SYSTEM = Object.freeze({ id: 0, role: 'admin', extra_roles: [] });
const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

function visitRow(db, visitId) {
  const id = Number(visitId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare(`
    SELECT id, patient_id, doctor_id, status, sync_origin, visit_date,
           ${localDate('visit_date')} AS day
      FROM visits WHERE id = ?`).get(id) || null;
}

/** Запись до прихода и своего здания — единственное, что зеркало трогает. */
export function isPreArrival(v) {
  return !!v && v.sync_origin == null && PRE_ARRIVAL.includes(v.status);
}

/**
 * ПРИХОД БЕЗ ОТМЕТКИ. Кнопку «Пришёл» в клинике не нажимает никто (разбор —
 * crm/visit-status.js): у пришедшего, заплатившего и принятого пациента визит
 * так и стоит 'scheduled'. Поэтому «до прихода» — это ещё и отсутствие
 * доказательств прихода: оплаты, работы над пациентом, закрытых строк заявки.
 * Иначе зеркало продолжало бы переписывать заявку по ходу приёма.
 */
export function arrivedByEvidence(db, visitId) {
  if (db.prepare('SELECT 1 FROM invoices WHERE visit_id = ? AND paid_amount > 0 LIMIT 1').get(visitId)) return true;
  const marks = EVIDENCE_SERVICE_STATUSES.map(() => '?').join(',');
  if (db.prepare(`SELECT 1 FROM visit_services WHERE visit_id = ? AND status IN (${marks}) LIMIT 1`).get(visitId, ...EVIDENCE_SERVICE_STATUSES)) return true;
  return !!db.prepare("SELECT 1 FROM crm_request_services WHERE visit_id = ? AND status = 'done' LIMIT 1").get(visitId);
}

/** До прихода по статусу И по доказательствам. */
function beforeArrival(db, v) {
  return isPreArrival(v) && !arrivedByEvidence(db, v.id);
}

/**
 * Строка визита «свободна»: её можно снять, перенести или заменить, ничего не
 * потеряв. Всё остальное — уже работа или деньги.
 */
function vsFree(db, vs) {
  if (!vs) return false;
  if (vs.status !== 'added' || vs.invoice_item_id != null) return false;
  if (vs.sync_origin != null || vs.clinic_item_id != null) return false;
  for (const t of VS_CHILDREN) {
    try { if (db.prepare(`SELECT 1 FROM ${t} WHERE visit_service_id = ? LIMIT 1`).get(vs.id)) return false; }
    catch { /* таблицы нет в этой сборке — держать нечему */ }
  }
  return true;
}

/** Есть ли по записи работа или деньги: счёт или строка дальше «в смете». */
export function visitHasWork(db, visitId) {
  if (db.prepare('SELECT 1 FROM invoices WHERE visit_id = ? LIMIT 1').get(visitId)) return true;
  return !!db.prepare(`SELECT 1 FROM visit_services
                        WHERE visit_id = ? AND (status <> 'added' OR invoice_item_id IS NOT NULL) LIMIT 1`).get(visitId);
}

/** Заявка, которой принадлежит запись: по её строкам, иначе по привязке. */
export function requestOfVisit(db, visitId) {
  const byLine = db.prepare(`SELECT MIN(request_id) AS r FROM crm_request_services
                              WHERE visit_id = ? AND status <> 'cancelled'`).get(visitId);
  if (byLine && byLine.r) return byLine.r;
  try {
    // Заявку могли удалить (администратор) — привязка к ней ничего не значит.
    const l = db.prepare(`SELECT b.request_id FROM crm_booking_links b
                            JOIN crm_requests r ON r.id = b.request_id WHERE b.visit_id = ?`).get(visitId);
    return l ? l.request_id : null;
  } catch { return null; }
}

/**
 * КЛЮЧ УСЛУГИ СТРОКИ — одинаковый у строки заявки и строки визита: услуга
 * каталога ('s:12') или консультация по виду приёма ('c:5', service_id NULL,
 * миграция 188). null — строке нечего зеркалить (товар, пустая строка).
 */
export function lineKey(row) {
  if (!row) return null;
  if (row.service_id != null) return 's:' + row.service_id;
  if (row.consultation_type_id != null) return 'c:' + row.consultation_type_id;
  return null;
}

/** Цена строки визита — тем же правилом, что у регистратуры и кассы. */
export function priceFor(db, { patientId, visitId, day, serviceId, doctorId, consultationTypeId = null }) {
  // BILLING_AUDIT_FIX_V1 (B7) — консультация: цена врача по виду приёма, а не
  // присланная браузером (lineUnitPrice → consultationFor).
  if (!serviceId && consultationTypeId) {
    const unit = round2(lineUnitPrice(db, { service_id: null, consultation_type_id: consultationTypeId, doctor_id: doctorId || null, unit_price: 0 }));
    return { unit, tier: null };
  }
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
  let tier = 'primary';
  try {
    const q = servicePriceQuote(db, {
      patient_id: patientId, service_ids: [serviceId], visit_id: visitId, date: day, doctor_id: doctorId || undefined,
    }, SYSTEM).quotes[serviceId];
    if (q && (q.tier === 'secondary' || q.tier === 'repeat')) tier = q.tier;
  } catch { /* котировка не сложилась — цена каталога */ }
  const unit = round2(lineUnitPrice(db, { service_id: serviceId, doctor_id: doctorId || null, price_tier: tier }, { service: svc }));
  return { unit, tier };
}

/** Строка визита 'added' — одна дверь для зеркала и для RPC колл-центра. */
export function insertBookingLine(db, { visit, serviceId = null, consultationTypeId = null, doctorId, createdBy, scheduledAt = null }) {
  const { unit, tier } = priceFor(db, {
    patientId: visit.patient_id, visitId: visit.id, day: visit.day, serviceId, doctorId, consultationTypeId,
  });
  const info = db.prepare(`
    INSERT INTO visit_services (visit_id, service_id, consultation_type_id, doctor_id, quantity, unit_price, total, status, price_tier, created_by, scheduled_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, 'added', ?, ?, ?)`)
    .run(visit.id, serviceId || null, serviceId ? null : (consultationTypeId || null), doctorId || null, unit, unit, tier, createdBy || null, scheduledAt);
  return Number(info.lastInsertRowid);
}

function deleteVs(db, id) {
  try { db.prepare('DELETE FROM service_queue_tickets WHERE visit_service_id = ?').run(id); } catch { /* нет таблицы */ }
  db.prepare('DELETE FROM visit_services WHERE id = ?').run(id);
}

/**
 * ДАТА И СТУПЕНЬ ЗАЯВКИ — ЗЕРКАЛО ЕЁ СТРОК (миграция 057). Только у ЖИВОЙ
 * заявки и только если у неё есть ждущие строки: заявка без строк (лид из
 * звонка) свою дату держит сама. Ступень едет только вперёд — в «Записан», и
 * только из колонок ДО него (то же правило, что settleCrmOnBooking).
 */
export function touchRequest(db, requestId) {
  if (!requestId) return;
  const p = db.prepare('SELECT id, status, scheduled_date FROM crm_requests WHERE id = ?').get(requestId);
  if (!p) return;
  const open = openStageKeys(db);
  if (!open.includes(p.status)) return;
  const left = db.prepare(`
    SELECT COUNT(*) AS n, MIN(NULLIF(scheduled_date, '')) AS next,
           SUM(visit_id IS NOT NULL) AS booked
      FROM crm_request_services WHERE request_id = ? AND status = 'pending'`).get(requestId);
  if (!left || !left.n) return;
  const scheduled = scheduledStageKey(db);
  const schedAt = scheduled ? open.indexOf(scheduled) : -1;
  const at = open.indexOf(p.status);
  const status = (left.booked && schedAt >= 0 && at >= 0 && at < schedAt) ? scheduled : p.status;
  const when = left.next || p.scheduled_date || null;
  if (status === p.status && when === p.scheduled_date) return;
  db.prepare(`UPDATE crm_requests SET status = ?, scheduled_date = ?,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(status, when, requestId);
}

/**
 * СВЕРКА ОДНОЙ ЗАПИСИ. Возвращает { created, linked, cancelled, removed, moved }
 * — сколько чего сделано (для тестов и логов); null — запись не до прихода.
 */
export function mirrorVisit(db, visitId, { actorId = null } = {}) {
  try {
    const v = visitRow(db, visitId);
    if (!beforeArrival(db, v)) return null;
    return db.transaction(() => mirrorVisitTx(db, v, actorId))();
  } catch (e) {
    console.error('[crm-mirror] запись', visitId, 'не сверена:', e && e.message);
    return null;
  }
}

function mirrorVisitTx(db, v, actorId) {
  const out = { created: 0, linked: 0, cancelled: 0, removed: 0, moved: 0, lines: 0 };
  const V = v.id;
  const touched = new Set();
  const getVs = db.prepare('SELECT * FROM visit_services WHERE id = ?');
  const linkLine = db.prepare('UPDATE crm_request_services SET visit_service_id = ?, visit_service_auto = ? WHERE id = ?');
  const referencedBy = db.prepare('SELECT id, status FROM crm_request_services WHERE visit_service_id = ?');

  // 1. СНЯТЫЕ В ЗАЯВКЕ. Строка заявки отменена — её строка визита уходит
  //    (если свободна). Выставленная или начатая остаётся: её правит касса.
  const cancelled = db.prepare(`
    SELECT l.id, l.visit_service_id FROM crm_request_services l
      JOIN visit_services vs ON vs.id = l.visit_service_id
     WHERE vs.visit_id = ? AND l.status = 'cancelled'`).all(V);
  for (const c of cancelled) {
    const vs = getVs.get(c.visit_service_id);
    const others = referencedBy.all(c.visit_service_id).filter((x) => x.id !== c.id && x.status !== 'cancelled');
    if (vs && !others.length && vsFree(db, vs)) { deleteVs(db, vs.id); out.removed++; }
  }

  // 2. СТРОКИ ЗАЯВКИ ЭТОЙ ЗАПИСИ → СТРОКИ ВИЗИТА.
  const lines = db.prepare(`SELECT * FROM crm_request_services
                             WHERE visit_id = ? AND status = 'pending' ORDER BY id`).all(V);
  const vsOfVisit = () => db.prepare('SELECT * FROM visit_services WHERE visit_id = ? ORDER BY id').all(V);
  const isReferenced = (id) => referencedBy.all(id).length > 0;
  for (const line of lines) {
    const key = lineKey(line);
    if (!key) continue;
    const vs = line.visit_service_id ? getVs.get(line.visit_service_id) : null;
    if (line.visit_service_id && !vs) {
      // Строку визита сняли в календаре или в окне визита — снимаем и в заявке.
      db.prepare("UPDATE crm_request_services SET status = 'cancelled' WHERE id = ?").run(line.id);
      touched.add(line.request_id); out.cancelled++;
      continue;
    }
    if (vs && vs.visit_id === V) continue;
    if (vs && vs.visit_id !== V && lineKey(vs) === key && vsFree(db, vs)) {
      // ПЕРЕНОС ИЗ ЗАЯВКИ: строка уехала на другой день — её строка визита едет
      // следом, а не заводится второй. Цена пересчитывается: другой день —
      // другой тариф повторного визита.
      const { unit, tier } = priceFor(db, { patientId: v.patient_id, visitId: V, day: v.day, serviceId: line.service_id, doctorId: line.doctor_id, consultationTypeId: line.consultation_type_id });
      db.prepare('UPDATE visit_services SET visit_id = ?, doctor_id = ?, unit_price = ?, total = ? * quantity, price_tier = ? WHERE id = ?')
        .run(V, line.doctor_id || null, unit, unit, tier, vs.id);
      touched.add(line.request_id); out.moved++;
      continue;
    }
    // Уже есть такая услуга в визите и ни одна строка заявки её не держит —
    // берём её, а не заводим вторую (её поставила регистратура раньше нас).
    const cand = vsOfVisit().find((x) => lineKey(x) === key && !isReferenced(x.id) && x.clinic_item_id == null);
    if (cand) { linkLine.run(cand.id, 0, line.id); out.linked++; touched.add(line.request_id); continue; }
    const id = insertBookingLine(db, { visit: v, serviceId: line.service_id, consultationTypeId: line.consultation_type_id, doctorId: line.doctor_id, createdBy: actorId });
    linkLine.run(id, 1, line.id);
    out.created++; touched.add(line.request_id);
  }

  // 3. СТРОКИ ВИЗИТА → СТРОКИ ЗАЯВКИ. Услугу добавили в календаре/окне визита.
  // Строки заявки заводятся только в ЖИВОЙ заявке: закрытая («Отказ», «Пришёл»)
  // историей не переписывается.
  let reqId = requestOfVisit(db, V);
  if (reqId) {
    const st = db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(reqId);
    if (!st || !openStageKeys(db).includes(st.status)) reqId = null;
  }
  for (const x of vsOfVisit()) {
    if (!getVs.get(x.id)) continue;   // уступила место выше в этом же проходе
    if (!lineKey(x) || x.clinic_item_id != null || x.sync_origin != null) continue;
    if (x.status !== 'added' || x.invoice_item_id != null) continue;
    if (isReferenced(x.id)) continue;
    // ЗАМЕНА СТРОКИ ЗЕРКАЛА. Регистратура в день приёма подставляет строки
    // заявки в смету и вставляет СВОИ строки визита (со своей ценой, пакетом,
    // плательщиком). Строка, заведённая зеркалом под ту же услугу, уступает
    // место: вторая строка той же услуги — это двойной счёт.
    const auto = db.prepare(`SELECT * FROM crm_request_services
                              WHERE visit_id = ? AND status = 'pending'
                                AND visit_service_auto = 1 AND visit_service_id IS NOT NULL AND visit_service_id <> ?
                              ORDER BY id`).all(V, x.id).find((l) => lineKey(l) === lineKey(x));
    if (auto) {
      const old = getVs.get(auto.visit_service_id);
      if (old && old.visit_id === V && vsFree(db, old)) {
        linkLine.run(x.id, 0, auto.id);
        deleteVs(db, old.id);
        out.linked++; out.removed++;
        continue;
      }
    }
    if (!reqId) continue;   // запись не из заявки — зеркалить некуда
    db.prepare(`INSERT INTO crm_request_services
                  (request_id, service_id, consultation_type_id, scheduled_date, status, doctor_id, visit_id, visit_service_id, visit_service_auto)
                VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, 0)`)
      .run(reqId, x.service_id ?? null, x.service_id != null ? null : x.consultation_type_id, v.day, x.doctor_id || null, V, x.id);
    out.lines++; touched.add(reqId);
  }

  for (const r of touched) touchRequest(db, r);
  return out;
}

/**
 * ПЕРЕНОС В КАЛЕНДАРЕ → ЗАЯВКА. Зовёт calendar_book, когда у записи до прихода
 * сменились день или врач. Строки заявки получают новый день; врач строк,
 * стоявших на прежнем враче записи, — новый (строка без врача — «на дату»,
 * лаборатория — остаётся без врача). Строки визита, стоявшие на прежнем враче и
 * ещё свободные, едут с ним и переоцениваются (личная цена врача).
 */
export function mirrorReschedule(db, visitId, { oldDoctorId = null } = {}) {
  try {
    const v = visitRow(db, visitId);
    if (!beforeArrival(db, v)) return;
    db.transaction(() => {
      const lines = db.prepare("SELECT id, request_id, doctor_id FROM crm_request_services WHERE visit_id = ? AND status = 'pending'").all(v.id);
      const linked = lines.length || requestOfVisit(db, v.id);
      if (!linked) return;   // запись не из заявки — прежнее поведение календаря
      db.prepare("UPDATE crm_request_services SET scheduled_date = ? WHERE visit_id = ? AND status = 'pending'").run(v.day, v.id);
      if (oldDoctorId && v.doctor_id && Number(oldDoctorId) !== Number(v.doctor_id)) {
        db.prepare("UPDATE crm_request_services SET doctor_id = ? WHERE visit_id = ? AND status = 'pending' AND doctor_id = ?")
          .run(v.doctor_id, v.id, oldDoctorId);
        const moving = db.prepare(`SELECT * FROM visit_services WHERE visit_id = ? AND doctor_id = ?`).all(v.id, oldDoctorId);
        for (const vs of moving) {
          if (!vsFree(db, vs) || !lineKey(vs)) continue;
          const { unit, tier } = priceFor(db, { patientId: v.patient_id, visitId: v.id, day: v.day, serviceId: vs.service_id, doctorId: v.doctor_id, consultationTypeId: vs.consultation_type_id });
          db.prepare('UPDATE visit_services SET doctor_id = ?, unit_price = ?, total = ? * quantity, price_tier = ? WHERE id = ?')
            .run(v.doctor_id, unit, unit, tier, vs.id);
        }
      }
      for (const r of new Set(lines.map((l) => l.request_id))) touchRequest(db, r);
    })();
  } catch (e) {
    console.error('[crm-mirror] перенос записи', visitId, 'не отражён в заявке:', e && e.message);
  }
}

/**
 * ЗАПИСЬ ИЗ КАЛЕНДАРЯ → ЗАЯВКА. Решение (консервативно, см. план 2026-09-27):
 *   • запись уже держит строки заявки (записали из CRM) — ничего не делаем;
 *   • у пациента есть ОТКРЫТАЯ заявка — запись привязывается к САМОЙ ПОЗДНЕЙ
 *     из них, заявка едет в «Записан» (только вперёд) с днём записи;
 *   • открытой заявки нет и записывает КОЛЛ-ЦЕНТР — заводим заявку так же,
 *     как запись из CRM: «Записан», оператор — он же, источник «Звонок»;
 *   • регистратура и врач новых заявок не заводят: пациент у стойки — не лид.
 * Возвращает id заявки или null.
 */
export function attachVisitToCrm(db, visitId, user) {
  try {
    const v = visitRow(db, visitId);
    if (!beforeArrival(db, v) || !v.patient_id) return null;
    return db.transaction(() => {
      const had = requestOfVisit(db, v.id);
      if (had) return had;
      const open = openStageKeys(db);
      if (!open.length) return null;
      let req = db.prepare(`SELECT id, status, scheduled_date FROM crm_requests
                             WHERE patient_id = ? AND status IN (${open.map(() => '?').join(',')})
                             ORDER BY created_at DESC, id DESC LIMIT 1`).get(v.patient_id, ...open);
      const scheduled = scheduledStageKey(db);
      if (!req) {
        if (!hasAnyRole(user, ['callcenter'])) return null;
        const p = db.prepare('SELECT full_name, phone FROM patients WHERE id = ?').get(v.patient_id) || {};
        const status = scheduled || open[0];
        const uid = user && Number.isInteger(Number(user.id)) && Number(user.id) > 0 ? Number(user.id) : null;
        const id = Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, source, status, patient_id, assigned_to, created_by, scheduled_date)
                                      VALUES (?, ?, 'call', ?, ?, ?, ?, ?)`)
          .run(p.full_name || '—', p.phone || '', status, v.patient_id, uid, uid, v.day).lastInsertRowid);
        db.prepare('INSERT OR REPLACE INTO crm_booking_links (visit_id, request_id) VALUES (?, ?)').run(v.id, id);
        return id;
      }
      db.prepare('INSERT OR REPLACE INTO crm_booking_links (visit_id, request_id) VALUES (?, ?)').run(v.id, req.id);
      const schedAt = scheduled ? open.indexOf(scheduled) : -1;
      const at = open.indexOf(req.status);
      const status = (schedAt >= 0 && at >= 0 && at < schedAt) ? scheduled : req.status;
      const was = String(req.scheduled_date || '').trim().slice(0, 10);
      const when = (!was || was > v.day) ? v.day : was;
      if (status !== req.status || when !== req.scheduled_date) {
        db.prepare(`UPDATE crm_requests SET status = ?, scheduled_date = ?,
                           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(status, when, req.id);
        // След для discard_empty_visit (миграция 186): убрали пустую запись —
        // заявка возвращается как была.
        try {
          db.prepare(`INSERT INTO crm_booking_undo (visit_id, request_id, prev_status, prev_scheduled_date, set_status, set_scheduled_date)
                      VALUES (?, ?, ?, ?, ?, ?)`).run(v.id, req.id, req.status, req.scheduled_date ?? null, status, when);
        } catch { /* сборка без 186 */ }
      }
      return req.id;
    })();
  } catch (e) {
    console.error('[crm-mirror] запись', visitId, 'не привязана к заявке:', e && e.message);
    return null;
  }
}

/**
 * Записи до прихода, которые держит заявка и которые можно отменить вместе с
 * ней: сегодня или позже, без работы и денег, без строк ДРУГИХ заявок.
 */
export function cancellableBookingsOf(db, requestId) {
  const ids = new Set(db.prepare(`SELECT DISTINCT visit_id AS id FROM crm_request_services
                                   WHERE request_id = ? AND status = 'pending' AND visit_id IS NOT NULL`)
    .all(requestId).map((r) => r.id));
  try {
    for (const r of db.prepare('SELECT visit_id AS id FROM crm_booking_links WHERE request_id = ?').all(requestId)) ids.add(r.id);
  } catch { /* сборка без 187 */ }
  const day = today(db);
  const out = [];
  for (const id of ids) {
    const v = visitRow(db, id);
    if (!isPreArrival(v) || v.day < day) continue;
    if (visitHasWork(db, id)) continue;
    const foreign = db.prepare(`SELECT 1 FROM crm_request_services
                                 WHERE visit_id = ? AND status = 'pending' AND request_id <> ? LIMIT 1`).get(id, requestId);
    if (foreign) continue;
    out.push(v);
  }
  return out;
}

/** Проигрышная ступень, означающая «отказались» (а не «не пришёл»). */
export function isRefusalStage(db, status) {
  const s = String(status || '');
  if (!s) return false;
  return lostStageKeys(db).includes(s) && s !== noShowStageKey(db);
}

/** Пустая запись до прихода: ни строк визита, ни ждущих строк заявки, ни счёта. */
export function isEmptyBooking(db, visitId) {
  const v = visitRow(db, visitId);
  if (!isPreArrival(v)) return false;
  if (db.prepare('SELECT 1 FROM visit_services WHERE visit_id = ? LIMIT 1').get(visitId)) return false;
  if (db.prepare('SELECT 1 FROM invoices WHERE visit_id = ? LIMIT 1').get(visitId)) return false;
  return !db.prepare("SELECT 1 FROM crm_request_services WHERE visit_id = ? AND status = 'pending' LIMIT 1").get(visitId);
}

/**
 * Какие записи задевает правка строк заявки: визит самой строки и визит её
 * строки визита (строка могла уехать с него на другой день).
 */
export function visitsOfLines(db, lineIds) {
  const ids = (lineIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  const holes = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT l.visit_id AS a, vs.visit_id AS b FROM crm_request_services l
      LEFT JOIN visit_services vs ON vs.id = l.visit_service_id
     WHERE l.id IN (${holes})`).all(...ids);
  return [...new Set(rows.flatMap((r) => [r.a, r.b]).filter(Boolean))];
}
