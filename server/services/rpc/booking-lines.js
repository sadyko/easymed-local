// ═══════════════════════════════════════════════════════════════════════════
// CRM_CALENDAR_MIRROR_V1 (2026-09-27) — УСЛУГИ ЗАПИСИ ОТ КОЛЛ-ЦЕНТРА
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: заявка и календарь — одна запись, «and the services». Оператор
// колл-центра, записавший пациента в календаре, записывает его С УСЛУГАМИ, а не
// голым слотом («Записано. Услуги добавит регистратура.» — убрано).
//
// ПОЧЕМУ RPC, А НЕ /api/db. Строки visit_services реестр вставляет только
// admin/registrar/doctor, и открыть таблицу колл-центру значило бы отдать ему
// всё, что эта таблица умеет: цену, пакет, статус работы, любую запись, в том
// числе пришедшего пациента. Здесь — узкая дверь ровно на одно действие:
//
//   • только запись ДО ПРИХОДА: визит scheduled/confirmed, день не прошёл,
//     ни счёта, ни начатой работы;
//   • только своего здания (строки чужого уезжают туда и правятся там);
//   • строка 'added' — «в смете», не больше; цену считает сервер тем же
//     правилом, что касса (service_price_quote + lineUnitPrice);
//   • ни счёта, ни оплаты — их по-прежнему делает регистратура и касса;
//   • без хирургии: она оформляется на госпитализацию (SURGERY_NEEDS_BED_V1);
//   • консультация по виду приёма — строкой service_id NULL + consultation_type_id,
//     цена по ценам врача (BILLING_AUDIT_FIX_V1 B7), миграция 188.
//
// После записи визит связывается с карточкой (crm/visit-link.js): запись колл-центра без
// карточки её получает. CRM_ONE_WAY_V1 — услуги записи живут только в визите: в карточку они
// не копируются (O2), карточка показывает их списком «Записи пациента»; желание карточки той же
// услуги указывает на добавленную строку (O1, crm/one-way.js), а не заводит вторую. Решение владельца
// (R2): услугу, которую добавил колл-центр, карточка держит строкой записи (указатель на эту строку
// визита, не копия) — отмена записи вернёт её в карточку без дня (O4).
import { hasAnyRole } from '../roles.js';
import { today } from '../domain/day.js';
import {
  isPreArrival, visitHasWork, insertBookingLine, arrivedByEvidence, lineKey,
  bookingLineRefusal, isCallcenterUser,
} from '../crm/booking-mirror.js';
import { adoptWishes, releaseOrphans, bookLinesOnCard } from '../crm/one-way.js';   // CRM_ONE_WAY_V1
import { crmLinkVisit } from '../crm/visit-link.js';   // CRM_UNIFY_V1
import { localDate } from '../domain/day.js';
import { journalLine, lineServiceName } from './registrar-desk.js';   // WAIT_REG_V1 (ревью) — журнал правок строк одной функцией (от имени — actingActorName)
import { assertLineTimeFree } from './calendar.js';   // SLOT_BUSY_LINES_V1 — строка со временем не ложится на занятое время врача

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const ROLES = ['admin', 'registrar', 'callcenter'];
const MAX_LINES = 30;
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const VS_CHILDREN = [
  ['lab_results', 'по услуге уже есть результаты анализа'],
  ['visit_documents', 'по услуге уже есть документ'],
  ['lab_device_messages', 'по услуге уже пришли данные анализатора'],
  ['service_queue_tickets', 'по услуге уже выдан талон очереди'],   // разбор ревью I2
];

// DIAG_ROUTE_V1 (3.22.0, ревью L-4) — ИСПОЛНИТЕЛЬ СТРОКИ ЗАПИСИ — ТОТ ЖЕ КРУГ, ЧТО У ЗАПИСИ
// (views/doctor-pool.js performerCandidates + doctorPoolFor): врач (is_doctor или роль «Врач»)
// или живой сотрудник, которому ЭТА услуга отмечена в «Услугах и ставках». Прежде — только врач:
// ЭКГ, отмеченное одной медсестре, календарь отдавал какому-нибудь врачу, и строка уходила не в
// тот кабинет. Консультация по виду приёма — только врач (отметок у неё нет).
export const BOOKING_PERFORMER_REFUSAL = 'Исполнитель строки — не врач и не отмечен на эту услугу («Сотрудники» → «Услуги и ставки»).';
function ratesOf(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
}
export function bookingPerformerOk(db, userId, serviceId) {
  const u = db.prepare('SELECT id, role, is_doctor, is_active, service_rates FROM users WHERE id = ?').get(userId);
  if (!u) return false;
  if (Number(u.is_doctor) === 1 || u.role === 'doctor') return true;   // как прежде (ревью M2)
  if (serviceId == null || Number(u.is_active) === 0) return false;
  return ratesOf(u.service_rates).some((r) => r && String(r.service_id) === String(serviceId));
}

/** Запись, к которой можно дописывать и с которой можно снимать услуги. */
function bookingOrRefuse(db, visitId) {
  const v = db.prepare(`SELECT id, patient_id, doctor_id, status, sync_origin, visit_date,
                               ${localDate('visit_date')} AS day FROM visits WHERE id = ?`).get(visitId);
  if (!v) throw new RpcError('Запись не найдена.', 404);
  if (v.sync_origin != null) throw new RpcError('Запись заведена в другом здании — её услуги правят там.', 400);
  if (!isPreArrival(v)) throw new RpcError('Пациент уже пришёл или запись отменена — услуги правит регистратура.', 400);
  if (v.day < today(db)) throw new RpcError('Приём уже прошёл — услуги правит регистратура.', 400);
  if (visitHasWork(db, v.id) || arrivedByEvidence(db, v.id)) throw new RpcError('По записи уже выставлен счёт или начата работа — услуги правит регистратура.', 400);
  return v;
}

/**
 * booking_lines_add { visit_id, lines: [{ service_id, doctor_id?, scheduled_at? }] }
 * → { visit_id, added: [{ id, service_id, unit_price }], skipped: [service_id] }
 * skipped — услуги, которые в записи уже есть: вторая строка той же услуги —
 * двойной счёт в день приёма.
 * SLOT_BUSY_LINES_V1 — строка к другому врачу со scheduled_at на занятое время этого
 * врача — отказ 409 slot_taken (params: doctor, from, to), как у calendar_book.
 */
export function bookingLinesAdd(db, args, user) {
  if (!hasAnyRole(user, ROLES)) throw new RpcError('Добавлять услуги к записи может колл-центр, регистратура или администратор.', 403);
  const visitId = Number(args && args.visit_id);
  if (!isPosInt(visitId)) throw new RpcError('Не выбрана запись.', 400);
  const raw = Array.isArray(args && args.lines) ? args.lines : [];
  if (!raw.length) throw new RpcError('Не выбраны услуги.', 400);
  if (raw.length > MAX_LINES) throw new RpcError(`За один раз можно добавить не больше ${MAX_LINES} услуг.`, 400);

  // Разбор ревью (M2) — экран называет пациента записи; чужая запись (не тот
  // пациент, которого оператор держит на линии) — отказ.
  const patientArg = args && args.patient_id != null && args.patient_id !== '' ? Number(args.patient_id) : null;
  const run = db.transaction(() => {
    const v = bookingOrRefuse(db, visitId);
    if (patientArg != null && Number(v.patient_id) !== patientArg) {
      throw new RpcError('Это запись другого пациента — добавить к ней услуги отсюда нельзя.', 400);
    }
    const added = [];
    const skipped = [];
    const seen = new Set(db.prepare('SELECT service_id, consultation_type_id FROM visit_services WHERE visit_id = ?')
      .all(visitId).map(lineKey).filter(Boolean));
    for (const l of raw) {
      // Строка — либо услуга каталога, либо консультация по виду приёма
      // (service_id NULL + consultation_type_id; цена — по ценам врача, B7).
      // Цену, присланную экраном, сервер не читает вовсе.
      const hasService = l && l.service_id != null && l.service_id !== '';
      const serviceId = hasService ? Number(l.service_id) : null;
      const consultId = !hasService && l && l.consultation_type_id != null && l.consultation_type_id !== '' ? Number(l.consultation_type_id) : null;
      if (hasService && !isPosInt(serviceId)) throw new RpcError('Услуга указана неверно.', 400);
      if (!hasService && !isPosInt(consultId)) throw new RpcError('Услуга указана неверно.', 400);
      // Одно правило с зеркалом (booking-mirror.js bookingLineRefusal): без
      // хирургии, без снятого с продажи, без выключенного вида приёма.
      const refusal = bookingLineRefusal(db, { serviceId, consultationTypeId: consultId });
      if (refusal) throw new RpcError(refusal, 400);
      const doctorId = l && l.doctor_id != null && l.doctor_id !== '' ? Number(l.doctor_id) : null;
      // M2 — врач строки должен быть врачом, а не любым сотрудником.
      // DIAG_ROUTE_V1 (ревью L-4) — или тем, кому эта услуга отмечена (bookingPerformerOk).
      if (doctorId != null && (!isPosInt(doctorId) || !bookingPerformerOk(db, doctorId, serviceId))) {
        throw new RpcError(BOOKING_PERFORMER_REFUSAL, 400);
      }
      const rawAt = l && l.scheduled_at != null && l.scheduled_at !== '' ? String(l.scheduled_at) : null;
      if (rawAt != null && Number.isNaN(Date.parse(rawAt))) throw new RpcError('Время услуги указано неверно.', 400);
      const key = lineKey({ service_id: serviceId, consultation_type_id: consultId });
      if (seen.has(key)) { skipped.push(serviceId || consultId); continue; }
      seen.add(key);
      const scheduledAt = rawAt ? new Date(Date.parse(rawAt)).toISOString() : null;
      // SLOT_BUSY_LINES_V1 — строка к врачу со временем («Добавить в этот визит») занимает его
      // время, значит и ложится только на свободное: та же занятость и тот же отказ slot_taken,
      // что у calendar_book. Своя запись не мешает; строка врача самой записи не проверяется
      // (rpc/calendar.js assertLineTimeFree). Отказ откатывает весь вызов — строк не остаётся.
      assertLineTimeFree(db, { visit: v, doctorId, scheduledAt, serviceId, consultationTypeId: consultId });
      const id = insertBookingLine(db, { visit: v, serviceId, consultationTypeId: consultId, doctorId, createdBy: user && user.id, scheduledAt });
      const row = db.prepare('SELECT id, service_id, consultation_type_id, unit_price FROM visit_services WHERE id = ?').get(id);
      added.push(row);
    }
    return { visit_id: visitId, added, skipped };
  });
  const out = run();
  // Запись связывается с заявкой пациента (колл-центру без неё — новая),
  // строки заявки — сами.
  crmLinkVisit(db, visitId, user);   // CRM_UNIFY_V1 · CRM_ONE_WAY_V1 — желания этого дня указывают на эти строки (O1)
  adoptWishes(db, visitId, out.added.map((a) => a.id));   // CRM_ONE_WAY_V1 — и желание «когда придёт» той же услуги
  // CRM_ONE_WAY_V1 (решение владельца R2) — услуга, которую колл-центр добавил к записи в календаре, —
  // строка записи карточки, держащей визит: отмена вернёт её в карточку без дня (O4).
  bookLinesOnCard(db, visitId, out.added.map((a) => a.id), { callcenter: isCallcenterUser(user) });
  return out;
}

// WAIT_REG_V1 (3.25.0) — СНЯТЬ СТРОКУ ЗАПИСИ ПРИ РЕГИСТРАЦИИ — ТОЛЬКО С ПРИЧИНОЙ, И ПРИЧИНА — В ЖУРНАЛЕ.
// Окно визита («Оформить по записи», visit-wizard.js) убирает строку «из записи» или анализ заявки
// «на дату» только с причиной (views/booked-drop.js) и присылает её сюда: сервер пишет её в журнал
// визита (invoice_audit_log, действие line_booked_removed — тот же журнал правок строк, что у обхода
// повтора DUP_STOP_V1 line_repeat_order; discard_empty_visit записи line_* визитом не считает) в той
// же транзакции, что снимает строку. Причина прислана — не короче трёх знаков (как у экстренной
// записи и повтора), иначе отказ и строка на месте. Без причины — как прежде (календарь, карточка CRM).
//
// WAIT_REG_V1 (ревью M3) — ОКНО РЕГИСТРАЦИИ БЕЗ ПРИЧИНЫ НЕ СНИМАЕТ. Окно визита и быстрая регистрация
// шлют registration: true — тогда причина обязательна (отказ, строка на месте), и забытое окном
// «спросить причину» не превращается в молча снятую запись. Календарь и карточка CRM флага не шлют
// и снимают как прежде: правило «сегодняшняя строка — только с причиной» сломало бы календарю
// правку записи на сегодня по звонку пациента (его выбрали как наименее вторгающееся).
// WAIT_REG_V1 (ревью L1) — журнал не говорит «при регистрации»: строка снимается ДО ensure_visit, и
// регистрация после неё может и не состояться; в журнале — номер строки визита (миграция 287).
const DROP_REASON_MIN = 3;
const DROP_REASON_MAX = 500;
function dropReasonArg(args) {
  const registration = !!(args && (args.registration === true || args.registration === 'true'));
  if (!args || args.reason === undefined || args.reason === null) {
    if (registration) throw new RpcError('Укажите причину: не короче трёх знаков.', 400);
    return null;
  }
  const r = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (r.length < DROP_REASON_MIN) throw new RpcError('Укажите причину: не короче трёх знаков.', 400);
  return r.slice(0, DROP_REASON_MAX);
}
function logBookedDrop(db, row, reason, user) {
  /* i18n-exempt-start: строка журнала ПИШЕТСЯ В БАЗУ, а не рисуется */
  journalLine(db, { visitId: row.visit_id, vsId: Number(row.id), action: 'line_booked_removed', reason,
    notes: `Услуга «${lineServiceName(db, row)}» снята с записи регистратурой` }, user);
  /* i18n-exempt-end */
}

/** booking_line_remove { visit_service_id, reason?, registration? } → { removed: true, id } */
export function bookingLineRemove(db, args, user) {
  if (!hasAnyRole(user, ROLES)) throw new RpcError('Снимать услуги с записи может колл-центр, регистратура или администратор.', 403);
  const id = Number(args && args.visit_service_id);
  if (!isPosInt(id)) throw new RpcError('Не выбрана услуга записи.', 400);
  const reason = dropReasonArg(args);   // WAIT_REG_V1 · ревью M3 — окну регистрации — обязательна
  const run = db.transaction(() => {
    const row = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id);
    if (!row) throw new RpcError('Услуга записи не найдена.', 404);
    if (row.sync_origin != null) throw new RpcError('Услуга заведена в другом здании — снять её можно только там.', 400);
    bookingOrRefuse(db, row.visit_id);
    if (row.invoice_item_id != null || row.status !== 'added') throw new RpcError('Услуга уже в счёте или в работе — снять её нельзя.', 400);
    if (row.clinic_item_id != null) throw new RpcError('Это выданный товар, а не услуга записи.', 400);
    for (const [table, why] of VS_CHILDREN) {
      let has = false;
      try { has = !!db.prepare(`SELECT 1 FROM ${table} WHERE visit_service_id = ? LIMIT 1`).get(id); }
      catch { has = false; }
      if (has) throw new RpcError('Снять нельзя: ' + why + '.', 400);
    }
    try { db.prepare('DELETE FROM service_queue_tickets WHERE visit_service_id = ?').run(id); } catch { /* нет таблицы */ }
    db.prepare('DELETE FROM visit_services WHERE id = ?').run(id);
    if (reason) logBookedDrop(db, row, reason, user);   // WAIT_REG_V1 — та же транзакция
    return row.visit_id;
  });
  const visitId = run();
  releaseOrphans(db, visitId);   // CRM_ONE_WAY_V1 (O3) — строки записи снятой услуги ждут в карточке без дня
  return { removed: true, id };
}
