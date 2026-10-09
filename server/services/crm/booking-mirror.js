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
// CRM_UNIFY_V1 — КАКАЯ ЗАЯВКА держит запись, решает crm/visit-link.js
// (crmLinkVisit): все двери записи зовут его перед сверкой.
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
                        WHERE visit_id = ? AND (status <> 'added' OR invoice_item_id IS NOT NULL
                                               OR clinic_item_id IS NOT NULL) LIMIT 1`).get(visitId);   // I4 — товар это работа
}

/**
 * V3120_FINAL (G3) — МОЖНО ЛИ ПЕРЕНЕСТИ ВИЗИТ ДНЯ ПОД НОВУЮ ЗАПИСЬ К `doctorId`.
 *
 * «Без работы» (visitHasWork) — мало: запись колл-центра к Иванову на 10:00
 * держит строку его консультации в смете ('added', без счёта), и новая запись
 * к Петрову на 14:00 переносила её целиком — время, врача (mirrorReschedule
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
function relinkHeld(db, fromId, toId) {
  db.prepare(`UPDATE crm_request_services SET visit_service_id = ?, visit_service_auto = 0
               WHERE visit_service_id = ? AND status <> 'cancelled'`).run(toId, fromId);
}

function deleteVs(db, id) {
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
  const live = "x.status NOT IN ('cancelled', 'no_show')";
  const booked = db.prepare(`
    SELECT MIN(d) AS d FROM (
      SELECT l.scheduled_date AS d FROM crm_request_services l
        JOIN visits x ON x.id = l.visit_id AND ${live}
       WHERE l.request_id = ? AND l.status = 'pending' AND date(l.scheduled_date) >= date(?)
      UNION ALL
      SELECT ${localDate('x.visit_date')} AS d FROM crm_booking_links b
        JOIN visits x ON x.id = b.visit_id AND ${live}
       WHERE b.request_id = ? AND ${localDate('x.visit_date')} >= date(?))`).get(requestId, day, requestId, day);
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
 * СВЕРКА ОДНОЙ ЗАПИСИ. Возвращает { created, linked, cancelled, removed, moved }
 * — сколько чего сделано (для тестов и логов); null — запись не до прихода.
 */
export function mirrorVisit(db, visitId, { actorId = null } = {}) {
  try {
    const v = visitRow(db, visitId);
    if (!beforeArrival(db, v)) {
      // CRM_UNIFY_V1 (ревью задачи 3, R1; проверка, N1/P1) — ПАЦИЕНТ ПРИШЁЛ.
      // Сверка больше ничего не снимает и не переносит, но две вещи делает и
      // теперь — при счёте и без него:
      //   • строки заявки, которые визит держит, а в визите их нет (взяли после
      //     прихода), встают в визит 'added' — как услуга, добавленная к уже
      //     пришедшему визиту: касса видит её в «Ждут счёта» (placeHeldLines);
      //   • строка зеркала той же услуги, ещё не в счёте, уступает место строке
      //     регистратуры или кассы — вторая строка той же услуги это двойной
      //     счёт (replaceAutoTwins).
      // Только своё здание и только живой визит.
      if (v && v.sync_origin == null && (isPreArrival(v) || v.status === 'arrived')) {
        placeHeldLines(db, v.id, { actorId });
        db.transaction(() => replaceAutoTwins(db, v))();
      }
      return null;
    }
    // Разбор ревью (I5): счёт выставлен или работа начата — строки визита
    // ведёт касса. Зеркало тогда только СВЯЗЫВАЕТ строки, но не ставит, не
    // снимает и не переносит их.
    const frozen = visitHasWork(db, v.id);
    return db.transaction(() => mirrorVisitTx(db, v, actorId, frozen))();
  } catch (e) {
    console.error('[crm-mirror] запись', visitId, 'не сверена:', e && e.message);
    return null;
  }
}

function mirrorVisitTx(db, v, actorId, frozen = false) {
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
    if (!frozen && vs && !others.length && vsFree(db, vs)) { deleteVs(db, vs.id); out.removed++; }
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
    if (vs && vs.visit_id === V) {
      if (lineKey(vs) === key) continue;
      // Разбор ревью (M1) — УСЛУГУ СТРОКИ ЗАЯВКИ СМЕНИЛИ. Свободная строка
      // визита уступает место новой; выставленная или начатая остаётся (её
      // правит касса), и заявка тогда не переписывает её ничем.
      // (Замена в карте пациента идёт обратным путём — syncLineFromVisit.)
      if (frozen || !vsFree(db, vs)) continue;
      deleteVs(db, vs.id); out.removed++;
      linkLine.run(null, 0, line.id);
    } else if (vs && !frozen && vs.visit_id !== V && lineKey(vs) === key && vsFree(db, vs)) {
      // ПЕРЕНОС ИЗ ЗАЯВКИ: строка уехала на другой день — её строка визита едет
      // следом, а не заводится второй. Цена пересчитывается: другой день —
      // другой тариф повторного визита.
      db.prepare('UPDATE visit_services SET visit_id = ?, doctor_id = ? WHERE id = ?').run(V, line.doctor_id || null, vs.id);
      // Разбор ревью (M5): цену переоцениваем только у строки, которую завело
      // само зеркало (её цена — наша); чужую цену (ручную, пакетную) не трогаем
      // — касса всё равно пересчитает строку при выставлении счёта.
      if (line.visit_service_auto) repriceOwn(db, v, vs.id);
      touched.add(line.request_id); out.moved++;
      continue;
    }
    // Уже есть такая услуга в визите — берём её, а не заводим вторую
    // (homeFor: её поставила регистратура раньше нас, или её делит вторая
    // карточка того же человека).
    const home = homeFor(db, V, line);
    if (home) { linkLine.run(home, 0, line.id); out.linked++; touched.add(line.request_id); continue; }
    if (frozen) continue;
    // C1 — хирургию и снятое с продажи зеркало в запись не ставит: строка
    // заявки остаётся ждать, запись — без неё.
    if (bookingLineRefusal(db, { serviceId: line.service_id, consultationTypeId: line.consultation_type_id })) continue;
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
    if (!lineKey(x) || x.clinic_item_id != null || x.sync_origin != null || x.status === 'cancelled') continue;
    if (isReferenced(x.id)) continue;
    // ЗАМЕНА СТРОКИ ЗЕРКАЛА. Регистратура в день приёма подставляет строки
    // заявки в смету и вставляет СВОИ строки визита (со своей ценой, пакетом,
    // плательщиком). Строка, заведённая зеркалом под ту же услугу, уступает
    // место: вторая строка той же услуги — это двойной счёт. CRM_UNIFY_V1
    // (проверка ревью задачи 3, P1) — и при счёте (I5 здесь не держит: уходит
    // только строка зеркала, которая сама НЕ в счёте), и перед строкой, которую
    // касса поставила сразу в счёт.
    const auto = autoLineFor(db, V, x);
    if (auto) {
      if (yieldAutoLine(db, V, x, auto)) { out.linked++; out.removed++; continue; }
      if (frozen) continue;   // I5 — при счёте вторую строку заявки не заводим
    }
    if (x.status !== 'added' || x.invoice_item_id != null) continue;
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

/**
 * Строка визита этой записи, которую строка заявки `line` берёт вместо новой.
 *   1. Та же услуга (sameService), и ни одна строка заявки её не держит — её
 *      поставила регистратура раньше нас.
 *   2. V3120_FIX — ВТОРАЯ КАРТОЧКА НА ТУ ЖЕ УСЛУГУ. Оператор завёл вторую
 *      заявку (не заметил первую) на ту же консультацию у того же врача в тот
 *      же день. Строка визита под эту услугу уже есть и её держит строка первой
 *      заявки — вторая строка заявки ДЕЛИТ её, а не заводит вторую строку
 *      визита: одна консультация — один счёт (было 200 000 вместо 100 000).
 *      Делёж безопасен: снятие одной из строк заявки строку визита не трогает,
 *      пока её держит другая (шаг 1 сверки — `others`). CRM_UNIFY_V1 — и строка
 *      первой заявки, уже закрытая приходом ('done').
 * null — такой нет, нужна новая.
 */
function homeFor(db, V, line) {
  const referencedBy = db.prepare('SELECT id, status FROM crm_request_services WHERE visit_service_id = ?');
  const rows = db.prepare('SELECT * FROM visit_services WHERE visit_id = ? ORDER BY id').all(V)
    .filter((x) => x.clinic_item_id == null && x.status !== 'cancelled');
  const cand = rows.find((x) => sameService(db, line, x) && !referencedBy.all(x.id).length);
  if (cand) return cand.id;
  const mk = matchKey(db, line);
  const shared = rows.find((x) => matchKey(db, x) === mk
    && referencedBy.all(x.id).some((r) => r.id !== line.id && r.status !== 'cancelled'));
  return shared ? shared.id : null;
}

/**
 * CRM_UNIFY_V1 (проверка ревью задачи 3, N1/P2) — СТРОКИ, КОТОРЫЕ ВИЗИТ ДЕРЖИТ,
 * А В ВИЗИТЕ ИХ НЕТ. Строка заявки взяла визит (visit_id), но строки визита у
 * неё нет (visit_service_id пуст): визит уже пришёл или при счёте, и сверка их
 * не ставит. Перед приходом и после него такая строка встаёт в визит так же,
 * как услуга, добавленная к уже выставленному или пришедшему визиту:
 *   • такая же услуга в визите уже есть — строка берёт её (homeFor);
 *   • иначе — новая строка визита 'added' (insertBookingLine — та же цена, что
 *     у регистратуры и кассы): касса видит её в «Ждут счёта», анализ уходит в
 *     лабораторию после оплаты, как обычно.
 * Поставить нельзя (хирургия, снятая с продажи) — строка заявки ЖДЁТ: закрыть
 * её без услуги в визите правило прихода не вправе (crm/visit-status.js).
 * Строку, чья строка визита ИСЧЕЗЛА (visit_service_id есть, строки нет — её
 * сняли), заново не ставит: снятую услугу снял человек.
 * Визит СОСЕДНЕГО здания (sync_origin) здесь не правится (BRANCH_MONEY_GUARD_V1):
 * строка заявки только берёт такую же услугу, если она приехала с визитом, и
 * ничего не ставит. Только живой визит. Не бросает.
 */
export function placeHeldLines(db, visitId, { actorId = null } = {}) {
  try {
    const v = visitRow(db, visitId);
    if (!v || (!PRE_ARRIVAL.includes(v.status) && v.status !== 'arrived')) return 0;
    const foreign = v.sync_origin != null;
    const lines = db.prepare(`SELECT * FROM crm_request_services
                               WHERE visit_id = ? AND status = 'pending' AND visit_service_id IS NULL ORDER BY id`).all(v.id);
    let placed = 0;
    const link = db.prepare('UPDATE crm_request_services SET visit_service_id = ?, visit_service_auto = ? WHERE id = ?');
    for (const line of lines) {
      if (!lineKey(line)) continue;
      db.transaction(() => {
        const home = homeFor(db, v.id, line);
        if (home) { link.run(home, 0, line.id); placed++; return; }
        if (foreign) return;
        if (bookingLineRefusal(db, { serviceId: line.service_id, consultationTypeId: line.consultation_type_id })) return;
        const id = insertBookingLine(db, { visit: v, serviceId: line.service_id, consultationTypeId: line.consultation_type_id, doctorId: line.doctor_id, createdBy: actorId });
        link.run(id, 1, line.id);
        placed++;
      })();
    }
    return placed;
  } catch (e) {
    console.error('[crm-mirror] строки заявки визита', visitId, 'не поставлены в визит:', e && e.message);
    return 0;
  }
}

/**
 * Строка заявки этого визита, державшая строку ЗЕРКАЛА той же услуги
 * (sameService), что и строка визита `x`. CRM_UNIFY_V1 (ревью задачи 3, R1) — при
 * любом статусе строки заявки, кроме снятой: после регистрации на стойке
 * строки этого визита уже 'done', а строка зеркала всё ещё в смете.
 */
function autoLineFor(db, V, x) {
  return db.prepare(`SELECT * FROM crm_request_services
                      WHERE visit_id = ? AND status <> 'cancelled'
                        AND visit_service_auto = 1 AND visit_service_id IS NOT NULL AND visit_service_id <> ?
                      ORDER BY id`).all(V, x.id).find((l) => sameService(db, l, x));
}

/**
 * Строка зеркала уступает место строке визита `x` (её поставила регистратура):
 * строки заявки переходят на `x`, свободная строка зеркала уходит. false —
 * строка зеркала уже не свободна (счёт, работа) или не этого визита.
 */
function yieldAutoLine(db, V, x, auto) {
  const old = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(auto.visit_service_id);
  if (!old || old.visit_id !== V || !vsFree(db, old)) return false;
  db.prepare('UPDATE crm_request_services SET visit_service_id = ?, visit_service_auto = 0 WHERE id = ?').run(x.id, auto.id);
  // V3120_FINAL — строку визита делят несколько заявок (две карточки одного
  // человека, CRM_ONE_LINE): на новую строку переходят ВСЕ строки, а не одна.
  // Оставшаяся со ссылкой на удалённую строку снималась следующей сверкой
  // («строку визита сняли — снимаем и в заявке»).
  relinkHeld(db, old.id, x.id);
  deleteVs(db, old.id);
  return true;
}

/**
 * CRM_UNIFY_V1 (ревью задачи 3, R1; проверка, P1) — ТОЛЬКО ЗАМЕНА СТРОК
 * ЗЕРКАЛА, для визита после прихода (mirrorVisit): строка визита, которую не
 * держит ни одна строка заявки (её только что поставила регистратура или касса
 * — в смету или сразу в счёт), занимает место строки зеркала той же услуги,
 * если та сама ещё не в счёте (yieldAutoLine → vsFree). До первого счёта и
 * после него. Ничего не ставит, не переносит и строк заявки не заводит.
 */
function replaceAutoTwins(db, v) {
  const getVs = db.prepare('SELECT * FROM visit_services WHERE id = ?');
  const referenced = db.prepare('SELECT 1 FROM crm_request_services WHERE visit_service_id = ? LIMIT 1');
  for (const x of db.prepare('SELECT * FROM visit_services WHERE visit_id = ? ORDER BY id').all(v.id)) {
    if (!getVs.get(x.id)) continue;   // уступила место выше в этом же проходе
    if (!lineKey(x) || x.clinic_item_id != null || x.sync_origin != null || x.status === 'cancelled') continue;
    if (referenced.get(x.id)) continue;
    const auto = autoLineFor(db, v.id, x);
    if (auto) yieldAutoLine(db, v.id, x, auto);
  }
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
          db.prepare('UPDATE visit_services SET doctor_id = ? WHERE id = ?').run(v.doctor_id, vs.id);
          if (isOwnLine(db, vs.id)) repriceOwn(db, v, vs.id);   // M5 — только своя цена
        }
      }
      for (const r of new Set(lines.map((l) => l.request_id))) touchRequest(db, r);
    })();
  } catch (e) {
    console.error('[crm-mirror] перенос записи', visitId, 'не отражён в заявке:', e && e.message);
  }
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
    for (const r of db.prepare('SELECT visit_id AS id FROM crm_booking_links WHERE request_id = ?').all(requestId)) ids.add(r.id);
  } catch { /* сборка без 187 */ }
  const day = today(db);
  const out = [];
  for (const id of ids) {
    const v = visitRow(db, id);
    if (!isPreArrival(v) || v.day < day) continue;
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

/**
 * CASHIER_HEAD_V1 (ревью) — УСЛУГА, ДОБАВЛЕННАЯ КАССОЙ, ПОПАДАЕТ В ЗАЯВКУ.
 *
 * Сверка mirrorVisit строки С СЧЁТОМ в заявку не переносит (шаг 3: «строки
 * визита ведёт касса»), а касса кладёт новую строку сразу в счёт. Здесь —
 * ровно этот случай: живая заявка этой записи получает строку, связанную с
 * новой строкой визита (не авто — её поставила касса). Закрытую заявку
 * («Отказ», «Пришёл») история не переписывает — как и в mirrorVisit.
 */
export function mirrorCashierLine(db, vsId) {
  try {
    const x = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(vsId);
    if (!x || x.clinic_item_id != null || x.sync_origin != null) return null;
    if (db.prepare('SELECT 1 FROM crm_request_services WHERE visit_service_id = ?').get(x.id)) return null;
    const reqId = requestOfVisit(db, x.visit_id);
    if (!reqId) return null;
    const st = db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(reqId);
    if (!st || !openStageKeys(db).includes(st.status)) return null;
    const v = visitRow(db, x.visit_id);
    const info = db.prepare(`INSERT INTO crm_request_services
                  (request_id, service_id, consultation_type_id, scheduled_date, status, doctor_id, visit_id, visit_service_id, visit_service_auto)
                VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, 0)`)
      .run(reqId, x.service_id ?? null, x.service_id != null ? null : (x.consultation_type_id ?? null), v ? v.day : null, x.doctor_id || null, x.visit_id, x.id);
    return Number(info.lastInsertRowid);
  } catch (e) {
    console.error('[crm-mirror] строка кассы', vsId, 'не отражена в заявке:', e && e.message);
    return null;
  }
}
