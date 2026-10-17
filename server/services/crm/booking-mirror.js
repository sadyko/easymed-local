// ═══════════════════════════════════════════════════════════════════════════
// CRM_CALENDAR_MIRROR_V1 (2026-09-27) — ЗАЯВКА И КАЛЕНДАРЬ — ОДНА ЗАПИСЬ
// CRM_ONE_WAY_V1 (2026-10-17) — ЗЕРКАЛА БОЛЬШЕ НЕТ: ЗДЕСЬ ОБЩИЕ ПРАВИЛА СТРОК ЗАПИСИ
// ═══════════════════════════════════════════════════════════════════════════
//
// До CRM_ONE_WAY_V1 этот файл держал двустороннюю копию: услуга записи жила строкой
// карточки (crm_request_services) и строкой визита (visit_services), и сверка
// mirrorVisit гоняла копии туда и обратно на каждой двери. Копии оборачивались двойным
// счётом и потерей услуг при отмене, восстановлении и переносе (CRM_TWIN_LINE, повторы
// ревью M1, M2, C1, M8). Владелец (2026-10-17): «Fix the root first» — услуга записи
// живёт ТОЛЬКО в визите, карточка её показывает, после отмены услуги остаются в
// карточке без даты (docs/specs/2026-10-17-crm-one-way-booking-design.md).
//
// Правила одного направления — crm/one-way.js; какая карточка держит визит — crm/visit-link.js.
// Карта того, куда ушла каждая обязанность зеркала, — docs/plans/2026-10-17-crm-one-way.md.
// Здесь остались общие правила строк записи, которыми пользуются все двери:
//   • до прихода ли визит (PRE_ARRIVAL, isPreArrival, arrivedByEvidence, beforeArrival);
//   • свободна ли строка визита, есть ли по записи работа (vsFree, visitHasWork,
//     dayVisitMovableFor);
//   • «та же услуга» (lineKey, matchKey, sameService) и чего в запись не ставят
//     (bookingLineRefusal); цена и вставка строки записи (priceFor, insertBookingLine);
//   • перепривязка и снятие строки (relinkHeld, deleteVs) — сеть R7b, разбор при первом
//     счёте (pruneAutoLinesOnInvoice), уступка строки CRM;
//   • дата и ступень карточки (cardDateOf, touchRequest), какая карточка держит визит
//     (requestOfVisit); «Отказ» отменяет записи колл-центра (cancellableBookingsOf);
//   • правка строки визита доходит до строки записи (syncLineFromVisit — O7) и цена своей
//     строки при смене врача (isOwnLine, repriceOwnLine).
//
// НЕ БРОСАЕТ (кроме insertBookingLine — его отказ ловят двери). Ошибка — в лог.

import { openStageKeys, scheduledStageKey, lostStageKeys, noShowStageKey } from './config.js';
import { localDate, today } from '../domain/day.js';
import { lineUnitPrice } from '../domain/pricing.js';
import { servicePriceQuote } from '../rpc/service-price-quote.js';
import { hasAnyRole } from '../roles.js';
import { EVIDENCE_SERVICE_STATUSES } from './visit-status.js';
import { displayLinkSql } from './display-links.js';   // CRM_LINK_ALL_V1 (ред. 2) — привязки «только для воронки»

/** Статусы визита, у которого пациент ещё не пришёл. Словарь — миграция 003. */
export const PRE_ARRIVAL = Object.freeze(['scheduled', 'confirmed']);

// Строки, которые держат строку визита: с ними она уже не «просто в смете».
// Тот же список, что у remove_own_visit_line (rpc/visit-lines.js).
// Разбор ревью (I2): выданный талон очереди тоже держит строку — снять её
// значило бы стереть номер, который пациент уже держит в руках.
const VS_CHILDREN = ['lab_results', 'visit_documents', 'lab_device_messages', 'service_queue_tickets'];

// Котировку спрашивает сама система, а не человек: цена строки, заведённой
// зеркалом, — та же, что поставила бы регистратура (service_price_quote +
// lineUnitPrice, одно правило с кассой).
const SYSTEM = Object.freeze({ id: 0, role: 'admin', extra_roles: [] });
const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

export function visitRow(db, visitId) {   // CRM_UNIFY_V1 — нужен crm/visit-link.js
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
  // Разбор ревью (I4): выданный пациенту товар — у стойки, а не по телефону.
  if (db.prepare('SELECT 1 FROM visit_services WHERE visit_id = ? AND clinic_item_id IS NOT NULL LIMIT 1').get(visitId)) return true;
  // Разбор ревью (I2): талон очереди выдают человеку в клинике.
  try {
    if (db.prepare(`SELECT 1 FROM service_queue_tickets t
                     WHERE t.visit_id = ? OR t.visit_service_id IN (SELECT id FROM visit_services WHERE visit_id = ?) LIMIT 1`).get(visitId, visitId)) return true;
  } catch { /* таблицы нет в этой сборке */ }
  return !!db.prepare("SELECT 1 FROM crm_request_services WHERE visit_id = ? AND status = 'done' LIMIT 1").get(visitId);
}

/** До прихода по статусу И по доказательствам. */
export function beforeArrival(db, v) {   // CRM_ONE_WAY_V1 — экспорт для crm/one-way.js
  return isPreArrival(v) && !arrivedByEvidence(db, v.id);
}

/**
 * Строка визита «свободна»: её можно снять, перенести или заменить, ничего не
 * потеряв. Всё остальное — уже работа или деньги.
 */
export function vsFree(db, vs) {   // CRM_LINK_ALL_V1 — экспорт для crm/booked-twin.js (правило не меняется)
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
                        WHERE visit_id = ? AND (status <> 'added' OR invoice_item_id IS NOT NULL
                                               OR clinic_item_id IS NOT NULL) LIMIT 1`).get(visitId);   // I4 — товар это работа
}

/**
 * V3120_FINAL (G3) — МОЖНО ЛИ ПЕРЕНЕСТИ ВИЗИТ ДНЯ ПОД НОВУЮ ЗАПИСЬ К `doctorId`.
 *
 * «Без работы» (visitHasWork) — мало: запись колл-центра к Иванову на 10:00
 * держит строку его консультации в смете ('added', без счёта), и новая запись
 * к Петрову на 14:00 переносила её целиком — время, врача (mirrorReschedule, с CRM_ONE_WAY_V1 — crm/one-way.js followVisitMove
 * переписывал и строки), освобождая слот Иванова. Переносится только
 *   • по-настоящему пустая запись (ни одной живой строки), или
 *   • запись, все строки которой — того же врача, к которому записывают (это
 *     перенос его же приёма); строка без врача (анализ «на дату») допустима,
 *     только если и у записи врача нет или он тот же.
 * Иначе — day_visit_busy: «добавьте услугу в этот визит».
 */
export function dayVisitMovableFor(db, visitId, doctorId) {
  const v = db.prepare('SELECT status, doctor_id FROM visits WHERE id = ?').get(visitId);
  if (!v || !PRE_ARRIVAL.includes(v.status)) return false;
  if (visitHasWork(db, visitId)) return false;
  const lines = db.prepare("SELECT doctor_id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'").all(visitId);
  if (!lines.length) return true;
  const doc = Number(doctorId) || null;
  if (!doc) return false;
  const visitDocOk = v.doctor_id == null || Number(v.doctor_id) === doc;
  return lines.every((l) => (l.doctor_id == null ? visitDocOk : Number(l.doctor_id) === doc));
}

/**
 * Заявка, которой принадлежит запись: по её строкам, иначе по привязке.
 * CRM_LINK_ALL_V1 (редакция 2) — привязку «только для воронки» (crm/display-links.js:
 * шаг C′, телефон) зеркало не видит: по ней услуги записи в карточку не пишутся.
 * display: true — видит и её (шаг связи crm/visit-link.js, ступень и дата).
 */
export function requestOfVisit(db, visitId, { display = false } = {}) {
  const byLine = db.prepare(`SELECT MIN(request_id) AS r FROM crm_request_services
                              WHERE visit_id = ? AND status <> 'cancelled'`).get(visitId);
  if (byLine && byLine.r) return byLine.r;
  try {
    // Заявку могли удалить (администратор) — привязка к ней ничего не значит.
    const l = db.prepare(`SELECT b.request_id FROM crm_booking_links b
                            JOIN crm_requests r ON r.id = b.request_id WHERE b.visit_id = ?${display ? '' : ` AND NOT ${displayLinkSql('b')}`}`).get(visitId);
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

/**
 * Разбор ревью (I1) — КЛЮЧ СОПОСТАВЛЕНИЯ: услуга И ВРАЧ, если без врача услуги
 * не бывает (консультация по виду приёма, услуга с requires_doctor). «Приём
 * терапевта у Иванова» и «Приём терапевта у Петрова» — две разные записи, и
 * вторая не вправе ни занять место первой, ни прицепиться к её строке заявки.
 * Анализ крови от врача не зависит — у него ключ без врача.
 */
export function matchKey(db, row) {
  const k = lineKey(row);
  if (!k) return null;
  let needs = row.service_id == null;   // консультация — всегда с врачом
  if (!needs) {
    const s = db.prepare('SELECT requires_doctor FROM services WHERE id = ?').get(row.service_id);
    needs = !!(s && Number(s.requires_doctor));
  }
  return needs ? k + '|d:' + (row.doctor_id || '') : k;
}

/**
 * Разбор ревью (C1) — ЧЕГО В ЗАПИСЬ ДО ПРИХОДА НЕ СТАВЯТ НИКОГДА, какой бы
 * дверью ни пришла строка: хирургии (оформляется на госпитализацию,
 * SURGERY_NEEDS_BED_V1), снятой с продажи услуги и выключенного вида приёма.
 * Одно правило на зеркало и на booking_lines_add. null — можно.
 */
export function bookingLineRefusal(db, { serviceId = null, consultationTypeId = null } = {}) {
  if (serviceId) {
    const svc = db.prepare('SELECT name, type, active FROM services WHERE id = ?').get(serviceId);
    if (!svc || Number(svc.active) === 0) return 'Услуга не найдена или снята с продажи.';
    if (svc.type === 'other') return `«${svc.name}» — хирургия: она оформляется на госпитализацию, её записывает регистратура.`;
    return null;
  }
  if (consultationTypeId) {
    const ct = db.prepare('SELECT active FROM consultation_types WHERE id = ?').get(consultationTypeId);
    if (!ct || Number(ct.active) === 0) return 'Вид приёма не найден или выключен.';
    return null;
  }
  return 'Услуга указана неверно.';
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
  const refusal = bookingLineRefusal(db, { serviceId, consultationTypeId });
  if (refusal) { const e = new Error(refusal); e.status = 400; throw e; }
  const { unit, tier } = priceFor(db, {
    patientId: visit.patient_id, visitId: visit.id, day: visit.day, serviceId, doctorId, consultationTypeId,
  });
  const info = db.prepare(`
    INSERT INTO visit_services (visit_id, service_id, consultation_type_id, doctor_id, quantity, unit_price, total, status, price_tier, created_by, scheduled_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, 'added', ?, ?, ?)`)
    .run(visit.id, serviceId || null, serviceId ? null : (consultationTypeId || null), doctorId || null, unit, unit, tier, createdBy || null, scheduledAt);
  return Number(info.lastInsertRowid);
}

// V3120_FINAL — строки заявок, державшие строку визита `fromId`, переходят на
// `toId` (строка визита уходит, её место заняла другая). CRM_UNIFY_V1 (ревью
// задачи 3, R1) — ждущие И закрытые приходом ('done'): после регистрации на
// стойке строки этого визита закрыты, а строка визита — та же услуга, и ссылка
// на ушедшую строку визита никому не нужна. Снятые ('cancelled') не переходят:
// снятая строка на чужой строке визита велела бы сверке снять и её.
export function relinkHeld(db, fromId, toId) {   // CRM_LINK_ALL_V1 — экспорт для crm/booked-twin.js
  db.prepare(`UPDATE crm_request_services SET visit_service_id = ?, visit_service_auto = 0
               WHERE visit_service_id = ? AND status <> 'cancelled'`).run(toId, fromId);
}

export function deleteVs(db, id) {   // CRM_LINK_ALL_V1 — экспорт для crm/booked-twin.js
  try { db.prepare('DELETE FROM service_queue_tickets WHERE visit_service_id = ?').run(id); } catch { /* нет таблицы */ }
  db.prepare('DELETE FROM visit_services WHERE id = ?').run(id);
}

/**
 * CRM_UNIFY_V1 (ревью 3, D4) — ДАТА КАРТОЧКИ: ОДНО ПРАВИЛО для шага связи
 * визита (crm/visit-link.js, шаг G) и сверки зеркала (touchRequest ниже).
 * Раньше их было два: шаг G брал записанный день, сверка — самую раннюю ждущую
 * строку, и незаписанная строка до дня визита перекидывала дату туда-обратно
 * на каждом клике двери, а след отмены (crm_booking_undo) рос.
 *
 *   1. ближайший с СЕГОДНЯШНЕГО дня ЗАПИСАННЫЙ день: ждущая строка, которую
 *      держит живой визит, или живой визит привязки записи (crm_booking_links);
 *   2. иначе — ближайшая ждущая строка с сегодняшнего дня;
 *   3. иначе — fallback: дата, которую ставит шаг связи (день визита) или
 *      прежняя дата карточки (сверка).
 * Строки прошлых дней в выбор не попадают: назад в прошлое дата не едет.
 */
export function cardDateOf(db, requestId, fallback = null) {
  const day = today(db);
  // CRM_ONE_WAY_V1 (O10) — записанный день — визит, который ЖДЁТ пациента (не пришедший), и
  // только визит пациента карточки: карточку перевели на другого пациента — визиты прежнего её
  // дату не ставят (приватность при чтении, триггер мигр. 246 снят).
  const live = "x.status IN ('scheduled', 'confirmed') AND x.patient_id = (SELECT patient_id FROM crm_requests WHERE id = @rid)"
    + " AND NOT EXISTS (SELECT 1 FROM invoices dpi WHERE dpi.visit_id = x.id AND dpi.paid_amount > 0)"
    + " AND NOT EXISTS (SELECT 1 FROM visit_services dps WHERE dps.visit_id = x.id AND dps.status IN ('collected', 'in_progress', 'resulted', 'completed'))";
  const booked = db.prepare(`
    SELECT MIN(d) AS d FROM (
      SELECT l.scheduled_date AS d FROM crm_request_services l
        JOIN visits x ON x.id = l.visit_id AND ${live}
       WHERE l.request_id = @rid AND l.status = 'pending' AND date(l.scheduled_date) >= date(@day)
      UNION ALL
      SELECT ${localDate('x.visit_date')} AS d FROM crm_booking_links b
        JOIN visits x ON x.id = b.visit_id AND ${live}
       WHERE b.request_id = @rid AND ${localDate('x.visit_date')} >= date(@day))`).get({ rid: requestId, day });
  if (booked && booked.d) return booked.d;
  const next = db.prepare(`SELECT MIN(scheduled_date) AS d FROM crm_request_services
                            WHERE request_id = ? AND status = 'pending' AND date(scheduled_date) >= date(?)`).get(requestId, day);
  return (next && next.d) || fallback;
}

/**
 * ДАТА И СТУПЕНЬ ЗАЯВКИ — ЗЕРКАЛО ЕЁ СТРОК (миграция 057). Только у ЖИВОЙ
 * заявки и только если у неё есть ждущие строки: заявка без строк (лид из
 * звонка) свою дату держит сама. Ступень едет только вперёд — в «Записан», и
 * только из колонок ДО него (то же правило, что crmLinkVisit — CRM_UNIFY_V1).
 *
 * CRM_UNIFY_V1 (ревью 2, F2; ревью 3, D4) — ДАТА — по cardDateOf, тому же
 * правилу, что у шага связи: только вперёд, сначала записанный день. Раньше
 * брался самый ранний день вообще, и незаписанная строка прошлой недели
 * возвращала записанной карточке прошедшую дату на каждом клике двери, а после
 * снятия услуги обход доски уносил карточку в «Не пришёл».
 */
export function touchRequest(db, requestId) {
  if (!requestId) return;
  const p = db.prepare('SELECT id, status, scheduled_date FROM crm_requests WHERE id = ?').get(requestId);
  if (!p) return;
  const open = openStageKeys(db);
  if (!open.includes(p.status)) return;
  const left = db.prepare(`
    SELECT COUNT(*) AS n, SUM(visit_id IS NOT NULL) AS booked
      FROM crm_request_services WHERE request_id = ? AND status = 'pending'`).get(requestId);
  if (!left || !left.n) return;
  const scheduled = scheduledStageKey(db);
  const schedAt = scheduled ? open.indexOf(scheduled) : -1;
  const at = open.indexOf(p.status);
  const status = (left.booked && schedAt >= 0 && at >= 0 && at < schedAt) ? scheduled : p.status;
  const when = cardDateOf(db, requestId, p.scheduled_date || null);   // CRM_UNIFY_V1 (D4)
  if (status === p.status && when === p.scheduled_date) return;
  db.prepare(`UPDATE crm_requests SET status = ?, scheduled_date = ?,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(status, when, requestId);
}

/**
 * CRM_UNIFY_V1 (проверка ревью задачи 3, P1b) — ТА ЖЕ УСЛУГА: ключ услуги
 * (lineKey) равен, и врач тот же (matchKey) — или у строки `a` врача нет вовсе.
 * Строка заявки «консультация терапевта» без врача и строка регистратуры
 * «консультация терапевта у Иванова» — одна консультация, а не две в счёте.
 * Две строки с РАЗНЫМИ врачами — по-прежнему разные записи (разбор ревью I1).
 */
export function sameService(db, a, x) {
  const k = lineKey(a);
  if (!k || k !== lineKey(x)) return false;
  return a.doctor_id == null || matchKey(db, a) === matchKey(db, x);
}

// CRM_UNIFY_V1 — «ЗАПИСЬ ИЗ КАЛЕНДАРЯ → ЗАЯВКА» (attachVisitToCrm) переехала в
// crm/visit-link.js (crmLinkVisit) — одно правило для всех дверей записи.
// «Чистый» колл-центр остаётся здесь: его зовут cancellableBookingsOf ниже и
// шаг E crmLinkVisit.
export function isCallcenterUser(user) {
  return hasAnyRole(user, ['callcenter']) && !hasAnyRole(user, ['registrar', 'doctor', 'admin']);
}

/**
 * Записи до прихода, которые держит заявка и которые можно отменить вместе с
 * ней: сегодня или позже, без работы и денег, без строк ДРУГИХ заявок — и
 * (разбор ревью I3) ТОЛЬКО записи колл-центра. Запись регистратуры или врача
 * отказ в CRM не отменяет никогда: пациента у стойки записывал не оператор, и
 * решать, отменять ли её, не ему.
 */
export function cancellableBookingsOf(db, requestId) {
  const ids = new Set(db.prepare(`SELECT DISTINCT visit_id AS id FROM crm_request_services
                                   WHERE request_id = ? AND status = 'pending' AND visit_id IS NOT NULL`)
    .all(requestId).map((r) => r.id));
  try {
    // CRM_LINK_ALL_V1 (редакция 2) — запись, привязанную только для воронки, «Отказ» не отменяет никогда.
    for (const r of db.prepare(`SELECT visit_id AS id FROM crm_booking_links b WHERE b.request_id = ? AND NOT ${displayLinkSql('b')}`).all(requestId)) ids.add(r.id);
  } catch { /* сборка без 187 */ }
  const day = today(db);
  const out = [];
  const card = db.prepare('SELECT patient_id FROM crm_requests WHERE id = ?').get(requestId);
  for (const id of ids) {
    const v = visitRow(db, id);
    if (!isPreArrival(v) || v.day < day) continue;
    // CRM_ONE_WAY_V1 (O10) — только записи пациента карточки (карточку могли перевести на другого).
    if (!card || card.patient_id == null || Number(card.patient_id) !== Number(v.patient_id)) continue;
    if (visitHasWork(db, id)) continue;
    const creator = db.prepare('SELECT u.role, u.extra_roles FROM visits x JOIN users u ON u.id = x.created_by WHERE x.id = ?').get(id);
    if (!creator) continue;
    let extra = creator.extra_roles;
    if (typeof extra === 'string') { try { extra = JSON.parse(extra); } catch { extra = []; } }
    if (!isCallcenterUser({ role: creator.role, extra_roles: Array.isArray(extra) ? extra : [] })) continue;
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

/**
 * Разбор ревью (M5) — ЦЕНУ МЕНЯЕМ ТОЛЬКО У СВОЕЙ СТРОКИ. Решение: строку,
 * заведённую зеркалом (visit_service_auto = 1) и без пакета, зеркало
 * переоценивает при переносе и смене врача — это его цена. Любую другую строку
 * (цена регистратуры, пакетная скидка, котировка колл-центра) оно не трогает:
 * при выставлении счёта касса (createInvoiceForVisit → lineUnitPrice) всё равно
 * выводит цену заново из врача, тарифа и пакета.
 */
export function isOwnLine(db, vsId) {
  return !!db.prepare('SELECT 1 FROM crm_request_services WHERE visit_service_id = ? AND visit_service_auto = 1 LIMIT 1').get(vsId);
}
function repriceOwn(db, v, vsId) {
  const vs = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(vsId);
  if (!vs || vs.package_id != null || !vsFree(db, vs)) return;
  const { unit, tier } = priceFor(db, { patientId: v.patient_id, visitId: v.id, day: v.day, serviceId: vs.service_id, doctorId: vs.doctor_id, consultationTypeId: vs.consultation_type_id });
  db.prepare('UPDATE visit_services SET unit_price = ?, total = ? * quantity, price_tier = ? WHERE id = ?').run(unit, unit, tier, vs.id);
}

/**
 * Разбор ревью (M1, обратный путь) — УСЛУГУ СТРОКИ ВИЗИТА ЗАМЕНИЛИ (карта
 * пациента, change_unpaid_service): строка заявки, которая за неё отвечает,
 * получает ту же услугу. Иначе ближайшая сверка решила бы, что услугу сменила
 * заявка, и вернула прежнюю.
 */
export function syncLineFromVisit(db, vsId) {
  try {
    const vs = db.prepare('SELECT id, service_id, consultation_type_id, doctor_id FROM visit_services WHERE id = ?').get(vsId);
    if (!vs) return;
    // CASHIER_HEAD_V1 (ревью) — и врача: касса меняет исполнителя строки
    // (cashier_line_set_doctor), и заявка не должна звать пациента к прежнему.
    db.prepare(`UPDATE crm_request_services SET service_id = ?, consultation_type_id = ?, doctor_id = ?
                 WHERE visit_service_id = ? AND status = 'pending'`)
      .run(vs.service_id ?? null, vs.service_id != null ? null : (vs.consultation_type_id ?? null), vs.doctor_id ?? null, vs.id);
  } catch (e) {
    console.error('[crm-mirror] замена услуги', vsId, 'не отражена в заявке:', e && e.message);
  }
}

/**
 * Разбор ревью (M6) — ПЕРВЫЙ СЧЁТ ЗАПИСИ. Строка, заведённая зеркалом, могла
 * остаться рядом со строкой регистратуры той же услуги у того же врача (строка
 * поставлена мимо двери /api/db). После первого счёта зеркало визит уже не
 * трогает (I5), поэтому убираем её здесь, в той же транзакции, что заводит
 * счёт: свободную (не в этом счёте, не выставленную, без талона и результатов)
 * строку зеркала, у которой есть «двойник» регистратуры; строка заявки
 * переходит на двойника. Нет двойника — строка остаётся: это услуга, которую
 * пациент ещё может получить, и снимать её вправе только человек.
 * CRM_UNIFY_V1 (ревью задачи 3, R1) — строка заявки при любом статусе, кроме
 * снятой: после регистрации на стойке строки этого визита уже 'done'.
 */
export function pruneAutoLinesOnInvoice(db, visitId, keepIds = []) {
  try {
    if (db.prepare('SELECT 1 FROM invoices WHERE visit_id = ? LIMIT 1').get(visitId)) return;
    const keep = new Set((keepIds || []).map(Number));
    const autos = db.prepare(`SELECT l.id AS line_id, l.visit_service_id AS vs_id FROM crm_request_services l
                               JOIN visit_services vs ON vs.id = l.visit_service_id
                              WHERE vs.visit_id = ? AND l.visit_service_auto = 1 AND l.status <> 'cancelled'`).all(visitId);
    for (const a of autos) {
      if (keep.has(Number(a.vs_id))) continue;
      const vs = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(a.vs_id);
      if (!vsFree(db, vs)) continue;
      // CRM_UNIFY_V1 (P1b) — та же услуга: и строка зеркала без врача.
      const twin = db.prepare('SELECT * FROM visit_services WHERE visit_id = ? AND id <> ?').all(visitId, vs.id)
        .find((x) => x.clinic_item_id == null && sameService(db, vs, x)
          && !db.prepare("SELECT 1 FROM crm_request_services WHERE visit_service_id = ? AND status <> 'cancelled'").get(x.id));
      if (!twin) continue;
      db.prepare('UPDATE crm_request_services SET visit_service_id = ?, visit_service_auto = 0 WHERE id = ?').run(twin.id, a.line_id);
      relinkHeld(db, vs.id, twin.id);   // V3120_FINAL — и остальные строки этой строки визита (CRM_UNIFY_V1 — и 'done')
      deleteVs(db, vs.id);
    }
  } catch (e) {
    console.error('[crm-mirror] строки зеркала при первом счёте не разобраны:', e && e.message);
  }
}

/** M5 — переоценка своей строки по её визиту (для двери /api/db). */
export function repriceOwnLine(db, vsId) {
  const vs = db.prepare('SELECT visit_id FROM visit_services WHERE id = ?').get(vsId);
  const v = vs ? visitRow(db, vs.visit_id) : null;
  if (v && isOwnLine(db, vsId)) repriceOwn(db, v, vsId);
}

