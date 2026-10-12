// PUBLIC_API_V1 — ЗАЯВКИ И ОНЛАЙН-ЗАПИСЬ ИЗ API: приём из очереди публичного
// сервера, удержание времени, подтверждение регистратором, встречное
// предложение, отказ, истечение, ответы партнёра (отмена, согласие с другим
// временем).
//
// ПРАВИЛА СПЕЦИФИКАЦИИ (docs/specs/2026-10-06-clinic-api-design.md):
//   • решение владельца 3 — заявка карту пациента не создаёт; время держится
//     без карты (services/api/holds.js); регистратор выбирает или заводит
//     карту, затем подтверждает;
//   • «Онлайн-запись» — только через ту же функцию записи, что у регистратора:
//     подтверждение зовёт ensure_visit (rpc/visits.js) с book — там живут
//     запрет двойной записи, правило «один пациент — один визит на день» и
//     связь с CRM; удержание 30 минут; наружу — только свободное время.
//   • решения владельца 18–19 (2026-10-11) — 30 РАБОЧИХ минут клиники (часы
//     главного здания, holds.js clinicOpenOn) от приёма заявки КЛИНИКОЙ, а не
//     от отправки партнёром: запись, пролежавшая в очереди, пока клиника была
//     без связи, не истекает в миг приёма. Правило — одна функция holdUntilFor
//     (shared/api-booking.js); здесь её зовут приём онлайн-записи и согласие
//     партнёра на другое время (оба ждут регистратора).
//
// ОДНА ЗАЯВКА ПАРТНЁРА — ОДНА КАРТОЧКА CRM с источником подключения (Р6
// плана): у неё свой номер, статус и ответ партнёру, и сливать её с чужой
// карточкой того же номера (окно повторного обращения звонков) значило бы
// смешать два ответа. Дубликаты по номеру видны в «Дубликатах» доски.
//
// РОВНО ОДИН ВИЗИТ НА ПОДТВЕРЖДЕНИЕ: переход pending → confirming — условный
// UPDATE, второй подтверждающий получает отказ, а не второй визит; повторное
// подтверждение уже записанной заявки отвечает тем же визитом.
//
// Деньги не трогаются: визит и его строки заводят ensure_visit и зеркало
// заявки (crm/booking-mirror.js) — по тем же ценам, что у регистратуры.
import { firstStageKey } from '../crm/contact-window.js';
import { dayVisitMovableFor, visitHasWork, PRE_ARRIVAL, mirrorVisit } from '../crm/booking-mirror.js';
import { crmLinkVisit } from '../crm/visit-link.js';   // повторная проверка 8a — доведение прерванного подтверждения
import { uzE164 } from '../../../public/js/admin/views/crm-phone-match.js';
import { findPatientsByPhone } from '../telegram/documents.js';
import { doctorPublicState } from '../../../public/js/shared/doctor-public.js';
import { consultOffered, consultMinutes, consultRowOf } from '../../../public/js/shared/consultation-price.js';
import { servicePublicState } from '../../../public/js/shared/service-public.js';
import { DEFAULT_DURATION_MIN, serviceDurationMinutes, formatHhmm } from '../rpc/slot-engine.js';
import { slotIsFree, calendarBook } from '../rpc/calendar.js';
import { ensureVisit } from '../rpc/visits.js';
import { localDate } from '../domain/day.js';
import { rpcT } from '../server-message.js';
import { consultationFor, lineUnitPrice } from '../domain/pricing.js';   // ревью 8a, M3 (повторная проверка, п. 5) — цена и имя, как у кассы
import {
  OFFER_MINUTES, EV, holdUntilFor, STAFF_DECLINE_REASONS, API_BOOKING_MESSAGES as MSG,
  parseInboxItem, isoOf, localIso, holdState, shownStatus, bookingActions, PARTNER_STATUS,
} from '../../../public/js/shared/api-booking.js';
import { enqueueEvent } from './outbox.js';
import { placeHold, releaseHolds, liveHoldOf, clinicOpenOn } from './holds.js';

export class BookingError extends Error {
  constructor(msg, status = 400, code = null) { super(msg); this.status = status; if (code) this.code = code; }
}

/** Кто отменяет визит по просьбе партнёра: сам сервер (calendar_book требует роль записи). */
const SYSTEM_BOOKER = Object.freeze({ id: null, role: 'admin', extra_roles: [] });
const offsetMin = (ms) => -new Date(ms).getTimezoneOffset();
const partnerTime = (iso) => { const ms = Date.parse(iso); return Number.isFinite(ms) ? localIso(ms, offsetMin(ms)) : ''; };
const localDayOf = (db, iso) => db.prepare(`SELECT ${localDate('?')} AS d`).get(iso).d;
const hhmmLocal = (iso) => { const d = new Date(Date.parse(iso)); return formatHhmm(d.getHours() * 60 + d.getMinutes()); };
const addDays = (dayIso, n) => { const [y, m, d] = dayIso.split('-').map(Number); const x = new Date(y, m - 1, d + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

export function requestRow(db, id) {
  const n = Number(id);
  const r = Number.isInteger(n) && n > 0 ? db.prepare('SELECT * FROM api_requests WHERE id = ?').get(n) : null;
  if (!r) throw new BookingError(MSG.notFound, 404, 'not_found');
  return r;
}
const byPublicId = (db, publicId) => db.prepare('SELECT * FROM api_requests WHERE public_id = ?').get(publicId);
const branchesById = (db) => new Map(db.prepare('SELECT id, active, show_public FROM branches').all().map((b) => [Number(b.id), b]));
function setStatus(db, id, fields, now) {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE api_requests SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...cols.map((c) => fields[c]), isoOf(now), id);
  return db.prepare('SELECT * FROM api_requests WHERE id = ?').get(id);
}

/**
 * Ревью 8a, I5 — КАРТОЧКА И ЕЁ ЖДУЩИЕ СТРОКИ НА ДЕНЬ ВРЕМЕНИ ЗАЯВКИ. Связь визита
 * с CRM (crm/visit-link.js) берёт строки и карточки только своего дня: после
 * «другого времени» на другой день строка консультации оставалась бы на старом
 * дне — визит без консультации, а чужой визит того дня забрал бы её в смету.
 */
//
// Повторная проверка 8a, п. 1: переносится ТОЛЬКО своя строка заявки
// (api_requests.crm_line_id, заведена при приёме) — не все ждущие строки
// карточки: анализ на другой день или строка второй онлайн-записи, слитой в ту
// же карточку («Дубликаты»), остаются на своих днях и не попадают в чужой
// визит. Дата карточки следует, только если её задавала эта строка.
//
// Финальная проверка 8a, п. 2: своя строка могла смениться — «Сохранить» окна
// карточки (crm.js saveLines) снимает ждущие строки без визита и заводит их
// заново под новыми номерами, слияние дублей (crm-merge.js) снимает двойник.
// Снятую (или исчезнувшую) строку заявка ищет снова по ключу: та же карточка,
// ждёт без визита, та же услуга (вид приёма), тот же врач и день прежнего
// времени заявки, — и запоминает найденную. Строка, которую уже взял визит,
// замены не ищет: она своё место нашла. Прежде перенос молча не случался:
// визит нового дня — без консультации, а строка на старом дне садилась в
// чужой визит того дня.
function ownLine(db, row) {
  const pick = "SELECT id, request_id, scheduled_date FROM crm_request_services WHERE id = ? AND status = 'pending' AND visit_id IS NULL";
  // Финальная проверка 8a, п. 4: crm_line_id — простой номер, не ссылка (мигр.
  // 143: на строки заявки не ссылается ни одна таблица). Номер, ведущий в чужую
  // карточку (пересборка таблицы), — тоже устаревший.
  const stored = db.prepare('SELECT id, status FROM crm_request_services WHERE id = ? AND request_id IS ?').get(row.crm_line_id, row.crm_request_id);
  if (stored && stored.status !== 'cancelled') return db.prepare(pick).get(stored.id) || null;
  if (!row.crm_request_id || !row.start_at) return null;
  const again = db.prepare(`
    SELECT id FROM crm_request_services
     WHERE request_id = ? AND status = 'pending' AND visit_id IS NULL
       AND service_id IS ? AND consultation_type_id IS ? AND doctor_id IS ? AND scheduled_date = ?
       AND id NOT IN (SELECT crm_line_id FROM api_requests WHERE crm_line_id IS NOT NULL AND id <> ?)
     ORDER BY id LIMIT 1`).get(row.crm_request_id, row.service_id || null, row.service_id ? null : (row.consultation_type_id || null),
    row.doctor_id || null, localDayOf(db, row.start_at), row.id);
  if (!again) return null;
  db.prepare('UPDATE api_requests SET crm_line_id = ? WHERE id = ?').run(again.id, row.id);
  return db.prepare(pick).get(again.id);
}

function cardToDay(db, row, dayIso) {
  if (!row.crm_line_id || !dayIso) return;
  const line = ownLine(db, row);
  if (!line || line.scheduled_date === dayIso) return;
  db.prepare('UPDATE crm_request_services SET scheduled_date = ? WHERE id = ?').run(dayIso, line.id);
  db.prepare('UPDATE crm_requests SET scheduled_date = ? WHERE id = ? AND scheduled_date IS ?').run(dayIso, line.request_id, line.scheduled_date);
}

// ─── ПРИЁМ ИЗ ОЧЕРЕДИ ───────────────────────────────────────────────────────

/** Карточка CRM заявки: источник подключения, первая колонка воронки, комментарий пациента. */
function createCard(db, { conn, v, day, line }) {
  const key = conn.crm_source_key;
  const crmId = Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, source, sources, status, note, scheduled_date)
                                   VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(v.patient.name, uzE164(v.patient.phone), key, JSON.stringify([key]), firstStageKey(db) || 'in_process',
      v.patient.comment, day).lastInsertRowid);
  let lineId = null;
  if (line && (line.service_id || line.consultation_type_id)) {
    lineId = Number(db.prepare(`INSERT INTO crm_request_services (request_id, service_id, consultation_type_id, doctor_id, scheduled_date, status)
                VALUES (?, ?, ?, ?, ?, 'pending')`)
      .run(crmId, line.service_id || null, line.service_id ? null : (line.consultation_type_id || null), line.doctor_id || null, day).lastInsertRowid);
  }
  return { crmId, lineId };
}

function insertRequest(db, row) {
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO api_requests (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}
const isUnique = (e) => e && String(e.code || '').startsWith('SQLITE_CONSTRAINT_UNIQUE');

// Ревью 8a, C1: элемент очереди мог прийти со ссылкой на то, чего в клинике уже
// нет (пакет удалили, пока заявка ждала, — решение 19), или с номером, которого
// клиника не публиковала. Такая ссылка не сохраняется (внешний ключ отказал бы и
// остановил приём всей очереди) — заявка принимается без неё.
const ownedId = (db, table, id) => (id && db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) ? id : null);
/** Длительность, которую хранит заявка и держит удержание (мигр. 245: 5–480 минут; меньше 5 календарь не записывает). */
const DURATION_MIN = 5;
const DURATION_MAX = 480;

function intakeRequest(db, v, conn, { now }) {
  const doctor = v.doctor_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(v.doctor_id) : null;
  const doctorId = doctor && doctorPublicState(doctor, branchesById(db)) === 'shown' ? doctor.id : null;
  const svc = v.service_id ? db.prepare('SELECT * FROM services WHERE id = ?').get(v.service_id) : null;
  const serviceId = svc && servicePublicState(svc) === 'shown' ? svc.id : null;
  return db.transaction(() => {
    const { crmId } = createCard(db, { conn, v, day: null, line: { service_id: serviceId, doctor_id: doctorId } });
    const id = insertRequest(db, {
      public_id: v.public_id, connection_id: conn.id, external_id: v.external_id, kind: 'request', status: 'new',
      crm_request_id: crmId, patient_name: v.patient.name, patient_phone: uzE164(v.patient.phone), comment: v.patient.comment,
      lang: v.lang, doctor_id: doctorId, service_id: serviceId, package_id: ownedId(db, 'service_templates', v.package_id),
      received_at: v.received_at, picked_at: isoOf(now),
    });
    return { applied: true, id, status: 'new' };
  })();
}

/**
 * Что записывает онлайн-запись и сколько длится: { consultationTypeId, serviceId, duration, reason }.
 * reason — 'not_bookable', если врача, вида приёма или услуги партнёрам не показывают.
 */
function bookableWhat(db, v, doctor) {
  const out = { consultationTypeId: null, serviceId: null, duration: DEFAULT_DURATION_MIN, reason: '' };
  if (!doctor || doctorPublicState(doctor, branchesById(db)) !== 'shown' || doctor.scheduling_mode === 'live_queue') {
    out.reason = 'not_bookable';
    return out;
  }
  if (v.consultation) {
    const ct = db.prepare('SELECT * FROM consultation_types WHERE api_kind = ?').get(v.consultation);
    const rows = ct ? db.prepare('SELECT * FROM doctor_consultation_prices WHERE doctor_id = ? AND consultation_type_id = ?').all(doctor.id, ct.id) : [];
    if (!ct || !consultOffered(ct, consultRowOf(rows, doctor.id, ct.id), doctor)) { out.reason = 'not_bookable'; return out; }
    out.consultationTypeId = ct.id;
    out.duration = consultMinutes(ct);
    return out;
  }
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(v.service_id);
  if (!svc || servicePublicState(svc) !== 'shown') { out.reason = 'not_bookable'; return out; }
  out.serviceId = svc.id;
  out.duration = serviceDurationMinutes(svc, DEFAULT_DURATION_MIN);
  return out;
}

function intakeAppointment(db, v, conn, { now, kekPath }) {
  const doctor = db.prepare('SELECT * FROM users WHERE id = ?').get(v.doctor_id) || null;
  const what = bookableWhat(db, v, doctor);
  const startMs = Date.parse(v.start_at);
  let reason = what.reason;
  // C1: услуга длиннее 480 минут онлайн не записывается (удержание и заявка
  // хранят 5–480); короче 5 — держится 5 минут: меньше календарь не записывает.
  if (!reason && what.duration > DURATION_MAX) reason = 'not_bookable';
  const duration = Math.min(DURATION_MAX, Math.max(DURATION_MIN, Number(what.duration) || DEFAULT_DURATION_MIN));
  if (!reason) {
    const horizon = Number(doctor.booking_days) > 0 ? Number(doctor.booking_days) : 14;
    const day = localDayOf(db, v.start_at);
    if (day > addDays(localDayOf(db, isoOf(now)), horizon - 1)) reason = 'not_bookable';
  }
  // Решения владельца 18–19: срок держания — 30 РАБОЧИХ минут клиники от
  // ЭТОГО приёма (now), а не от отправки партнёром (received_at): запись,
  // пролежавшая в очереди, пока клиника была без связи, держится от возвращения
  // клиники. Не дольше начала приёма — прошедший приём сразу «expired».
  const holdUntil = holdUntilFor(isoOf(now), v.start_at, { openOn: clinicOpenOn(db) });
  if (!reason && !(Date.parse(holdUntil) > now)) reason = 'expired';
  if (!reason && !slotIsFree(db, { doctorId: doctor.id, startMs, durationMin: duration, now })) reason = 'slot_taken';
  const status = !reason ? 'pending' : reason === 'expired' ? 'expired' : 'declined';
  return db.transaction(() => {
    const day = reason ? null : localDayOf(db, v.start_at);
    const { crmId, lineId } = createCard(db, { conn, v, day,
      line: { service_id: what.serviceId, consultation_type_id: what.consultationTypeId, doctor_id: doctor ? doctor.id : null } });
    const id = insertRequest(db, {
      public_id: v.public_id, connection_id: conn.id, external_id: v.external_id, kind: 'appointment', status,
      crm_request_id: crmId, crm_line_id: lineId, patient_name: v.patient.name, patient_phone: uzE164(v.patient.phone), comment: v.patient.comment,
      // C1: врача, которого нет (удалили, пока заявка ждала), не сохранить — отказ без врача.
      // I8: здание — приписка врача; номер здания от партнёра не решает ничего
      // (ошибка партнёра или старый снимок увели бы визит не туда).
      lang: v.lang, doctor_id: doctor ? doctor.id : null, branch_id: doctor ? ownedId(db, 'branches', doctor.branch_id) : null, service_id: what.serviceId,
      consultation_type_id: what.consultationTypeId, package_id: ownedId(db, 'service_templates', v.package_id), start_at: v.start_at,
      duration_minutes: duration, hold_until: reason ? null : holdUntil, decline_reason: reason,
      received_at: v.received_at, picked_at: isoOf(now),
    });
    const row = db.prepare('SELECT * FROM api_requests WHERE id = ?').get(id);
    if (!reason) {
      placeHold(db, { doctorId: doctor.id, startMs, durationMin: duration, untilMs: Date.parse(holdUntil), apiRequestId: id, kind: 'booking' });
    } else {
      enqueueEvent(db, { request: row, event: EV.declined, status, details: { reason, doctor_id: v.doctor_id, start: partnerTime(v.start_at) }, now, kekPath });
    }
    // hold_until — публичному серверу в подтверждении очереди (public-sync.js, held).
    return { applied: true, id, status, ...(reason ? {} : { hold_until: holdUntil }) };
  })();
}

/**
 * Один элемент входящей очереди. Идемпотентно: повтор того же номера ничего не
 * меняет. Никогда не бросает наружу причин разбора — { applied:false, problem }.
 * hold_until — у заявки, которую клиника этим элементом начала держать (новая
 * онлайн-запись, согласие на другое время): его узнаёт публичный сервер.
 * @returns {Promise<{applied:boolean, id?:number, status?:string, hold_until?:string, duplicate?:boolean, problem?:string}>}
 */
export async function ingestItem(db, raw, { now = Date.now(), kekPath = null } = {}) {
  const p = parseInboxItem(raw);
  if (!p.ok) return { applied: false, problem: p.problem };
  const v = p.value;
  const conn = db.prepare('SELECT * FROM api_connections WHERE id = ?').get(v.connection_id);
  if (!conn) return { applied: false, problem: 'connection' };
  if (v.type === 'request.new' || v.type === 'appointment.new') {
    if (byPublicId(db, v.public_id)) return { applied: false, duplicate: true };
    try {
      return v.type === 'request.new' ? intakeRequest(db, v, conn, { now }) : intakeAppointment(db, v, conn, { now, kekPath });
    } catch (e) {
      if (isUnique(e)) return { applied: false, duplicate: true };   // тот же номер партнёра у подключения
      throw e;
    }
  }
  const row = byPublicId(db, v.public_id);
  if (!row || row.connection_id !== conn.id) return { applied: false, problem: 'unknown_request' };
  // Отказ от другого времени — отмена партнёром (проверка исправлений 8b, B):
  // публичный сервер уже показывает партнёру «отменено» и предложения клиники в
  // пути ему не отдаёт, так что и клиника отменяет — даже если регистратор тем
  // временем предложил новое время. Ждущая заявка тоже отменяется, время свободно.
  if (v.type === 'appointment.cancel' || v.type === 'offer.decline') return partnerCancel(db, row, { now, kekPath });
  // Ревью 8b, C9: партнёр согласился на предложение, которого у клиники уже нет
  // (регистратор с тех пор предложил другое время), — согласие устарело: заявка
  // не меняется, партнёр увидит новое предложение и ответит на него. Без
  // offered_start (прежний сервер) — как прежде.
  if (v.offered_start && Date.parse(v.offered_start) !== Date.parse(row.offered_start || '')) {
    console.warn('[public-api] заявка', row.public_id, '— согласие партнёра на прежнее предложение, не применено');
    return { applied: false, stale: true, id: row.id, status: row.status };
  }
  return partnerAcceptOffer(db, row, { now, kekPath, answeredAt: v.received_at ? Date.parse(v.received_at) : null });
}

// ─── ПОДТВЕРЖДЕНИЕ ──────────────────────────────────────────────────────────

/**
 * Регистратор выбрал карту — записать. Та же дверь, что у регистратуры:
 * ensure_visit с book; удержание этой заявки ему не мешает (excludeHoldId).
 * @returns {Promise<{request:object, visit:object, already?:boolean, cross_branch?:object}>}
 */
export async function confirmBooking(db, { id, patientId }, user, { now = Date.now(), kekPath = null, ensureVisitImpl = ensureVisit } = {}) {
  const row = requestRow(db, id);
  if (row.kind !== 'appointment') throw new BookingError(MSG.notAppointment, 409);
  if (row.status === 'confirmed' && row.visit_id) {
    return { request: row, visit: db.prepare('SELECT * FROM visits WHERE id = ?').get(row.visit_id), already: true };
  }
  if (row.status === 'confirming') throw new BookingError(MSG.busy, 409, 'busy');
  if (row.status !== 'pending') throw new BookingError(MSG.notPending, 409);
  const hold = liveHoldOf(db, row.id, now);
  if (!hold) { expireDue(db, { now, kekPath }); throw new BookingError(MSG.holdExpired, 409, 'hold_expired'); }
  const pid = Number(patientId);
  if (!Number.isInteger(pid) || pid <= 0) throw new BookingError(MSG.patient, 400);
  if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(pid)) throw new BookingError(MSG.patientMissing, 400);

  // Визит дня с работой — тот же отказ, что ensure_visit дал бы регистратору,
  // но ДО первой записи: иначе строки заявки ушли бы в смету того визита.
  const day = localDayOf(db, row.start_at);
  const dv = db.prepare(`SELECT * FROM visits WHERE patient_id = ? AND ${localDate('visit_date')} = ?
                           AND status NOT IN ('cancelled', 'no_show') AND sync_origin IS NULL ORDER BY id LIMIT 1`).get(pid, day);
  // Ревью 8a, I7: визит дня БЕЗ работы ensure_visit перенёс бы на время
  // онлайн-записи молча (dayVisitMovableFor) — запись колл-центра на 15:00
  // уехала бы на 10:00, а отмена партнёром потом отменила бы обе. Чужую запись
  // пациента подтверждение не двигает никогда: отказ day_visit_exists,
  // регистратор сам решает в календаре (перенести, отменить) или предлагает
  // партнёру другое время.
  if (dv) {
    const movable = dayVisitMovableFor(db, dv.id, row.doctor_id);
    const doc = dv.doctor_id ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(dv.doctor_id) : null;
    const err = rpcT(BookingError, movable ? MSG.dayVisitExists : MSG.dayVisitBusy, { start: hhmmLocal(dv.visit_date), doctor: (doc && doc.full_name) || '—' }, 409);
    err.code = movable ? 'day_visit_exists' : 'day_visit_busy';
    throw err;
  }

  if (db.prepare("UPDATE api_requests SET status = 'confirming', updated_at = ? WHERE id = ? AND status = 'pending'").run(isoOf(now), row.id).changes !== 1) {
    throw new BookingError(MSG.busy, 409, 'busy');
  }
  // Карточка получает ВЫБРАННУЮ карту — visit-link.js (шаг C) возьмёт её строки
  // этого дня в визит. Выбор регистратора сильнее догадки по номеру (шаг D мог
  // привязать карточку к другому члену семьи с тем же телефоном).
  const card = row.crm_request_id ? db.prepare('SELECT id, patient_id FROM crm_requests WHERE id = ?').get(row.crm_request_id) : null;
  const prevPatient = card ? card.patient_id : null;
  cardToDay(db, row, day);   // I5 — страж: строки заявки на дне её времени, что бы их ни сдвинуло
  if (card && card.patient_id !== pid) db.prepare('UPDATE crm_requests SET patient_id = ? WHERE id = ?').run(pid, card.id);
  try {
    const res = await ensureVisitImpl(db, {
      // Ревью 8a, I8: здание — приписка врача, сохранённая при приёме (номер
      // здания от партнёра не хранится): врач филиала — запись в чужое здание с
      // публикацией, врач главного — визит своего здания; без приписки —
      // календарь решает сам (bookingTarget).
      patient_id: pid, date: row.start_at, doctor_id: row.doctor_id, branch_id: row.branch_id || undefined,
      book: { doctor_id: row.doctor_id, start: row.start_at, duration_minutes: row.duration_minutes, service_id: row.service_id || undefined },
    }, user, { excludeHoldId: hold.id });
    if (!res || !res.booked) throw new BookingError(MSG.notPending, 409);
    const done = db.transaction(() => {
      // M1: пока подтверждение ждало (публикация в чужое здание за замком обмена),
      // фон мог уже довести заявку (recoverConfirming) — второго события не надо.
      const cur = db.prepare('SELECT * FROM api_requests WHERE id = ?').get(row.id);
      if (cur.status !== 'confirming') return cur;
      releaseHolds(db, row.id, 'confirmed', now);
      const out = setStatus(db, row.id, { status: 'confirmed', visit_id: res.visit.id, patient_id: pid, handled_by: (user && user.id) || null }, now);
      enqueueEvent(db, { request: out, event: EV.confirmed, status: 'confirmed',
        details: { doctor_id: out.doctor_id, branch_id: out.branch_id, start: partnerTime(res.visit.visit_date) }, now, kekPath });
      return out;
    })();
    return { request: done, visit: res.visit, ...(res.cross_branch ? { cross_branch: res.cross_branch } : {}) };
  } catch (e) {
    db.prepare("UPDATE api_requests SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'confirming'").run(isoOf(now), row.id);
    if (card && prevPatient !== pid) db.prepare('UPDATE crm_requests SET patient_id = ? WHERE id = ? AND patient_id = ?').run(prevPatient, card.id, pid);
    throw e;
  }
}

// ─── ДРУГОЕ ВРЕМЯ, ОТКАЗ, ЗАЯВКА В РАБОТУ ───────────────────────────────────

/** «Предложить другое время»: прежнее удержание снимается, новое держится 30 минут. */
export function offerOtherTime(db, { id, start, patientId = null }, user, { now = Date.now(), kekPath = null } = {}) {
  const row = requestRow(db, id);
  if (row.kind !== 'appointment') throw new BookingError(MSG.notAppointment, 409);
  if (!bookingActions(row, now).offer) throw new BookingError(holdState(row, now) === 'expired' ? MSG.holdExpired : MSG.notPending, 409);
  const startMs = Date.parse(String(start || ''));
  if (!Number.isFinite(startMs)) throw new BookingError(MSG.start, 400);
  if (startMs <= now) throw new BookingError(MSG.startPast, 400);
  const own = liveHoldOf(db, row.id, now);
  if (!slotIsFree(db, { doctorId: row.doctor_id, startMs, durationMin: row.duration_minutes, excludeHoldId: own ? own.id : null, now })) {
    throw new BookingError(MSG.slotTaken, 409, 'slot_taken');
  }
  const pid = Number(patientId);
  const keepPatient = Number.isInteger(pid) && pid > 0 && db.prepare('SELECT 1 FROM patients WHERE id = ?').get(pid) ? pid : row.patient_id;
  // Предложение ждёт ответа ПАРТНЁРА, а не регистратуры, — 30 обычных минут
  // (решение владельца 18 — о рабочих минутах клиники).
  const untilMs = Math.min(now + OFFER_MINUTES * 60000, startMs);
  return db.transaction(() => {
    releaseHolds(db, row.id, 'offered', now);
    placeHold(db, { doctorId: row.doctor_id, startMs, durationMin: row.duration_minutes, untilMs, apiRequestId: row.id, kind: 'offer' });
    const out = setStatus(db, row.id, { status: 'offered', offered_start: isoOf(startMs), offer_until: isoOf(untilMs),
      patient_id: keepPatient || null, handled_by: (user && user.id) || null }, now);
    enqueueEvent(db, { request: out, event: EV.offered, status: 'offered',
      details: { doctor_id: out.doctor_id, offered_start: partnerTime(out.offered_start), offer_until: partnerTime(out.offer_until) }, now, kekPath });
    return out;
  })();
}

/** «Отклонить»: время освобождается, партнёр получает отказ с причиной. */
export function declineBooking(db, { id, reason }, user, { now = Date.now(), kekPath = null } = {}) {
  const row = requestRow(db, id);
  if (row.kind !== 'appointment') throw new BookingError(MSG.notAppointment, 409);
  if (!STAFF_DECLINE_REASONS.includes(reason)) throw new BookingError(MSG.reason, 400);
  if (!bookingActions(row, now).decline) throw new BookingError(holdState(row, now) === 'expired' ? MSG.holdExpired : MSG.notPending, 409);
  return db.transaction(() => {
    releaseHolds(db, row.id, 'declined', now);
    const out = setStatus(db, row.id, { status: 'declined', decline_reason: reason, handled_by: (user && user.id) || null }, now);
    enqueueEvent(db, { request: out, event: EV.declined, status: 'declined', details: { reason, doctor_id: out.doctor_id }, now, kekPath });
    return out;
  })();
}

/** «Взять в работу» заявку без времени: партнёр получает «Заявка принята». */
export function acceptRequest(db, { id }, user, { now = Date.now(), kekPath = null } = {}) {
  const row = requestRow(db, id);
  if (row.kind !== 'request') throw new BookingError(MSG.notRequest, 409);
  if (row.status !== 'new') throw new BookingError(MSG.alreadyAccepted, 409);
  return db.transaction(() => {
    const out = setStatus(db, row.id, { status: 'accepted', handled_by: (user && user.id) || null }, now);
    enqueueEvent(db, { request: out, event: EV.accepted, status: 'accepted', now, kekPath });
    return out;
  })();
}

/** Ревью 8a, M1: подтверждение, не закончившееся за столько, считается прерванным. */
export const CONFIRM_STALE_MS = 5 * 60000;

/**
 * Ревью 8a, M1 — ПОДТВЕРЖДЕНИЕ, ПРЕРВАННОЕ ПЕРЕЗАПУСКОМ. confirmBooking ставит
 * 'confirming', ensure_visit записывает визит, а запись к врачу другого здания
 * потом ждёт публикацию за замком обмена (до 12 секунд и ожидание замка):
 * выключили ПК или перезапустили сервер в этот миг — заявка навсегда
 * «Подтверждается», визит ни к чему не привязан, партнёр не знает. Фон (каждый
 * такт) берёт такие заявки старше CONFIRM_STALE_MS: визит есть (карта карточки,
 * врач, то же мгновение) — доводит до «записан» с событием; визита нет — снова
 * ждёт, пока время держится, иначе истекает с отказом партнёру.
 */
function recoverConfirming(db, { now, kekPath }) {
  let rows = [];
  try { rows = db.prepare("SELECT * FROM api_requests WHERE status = 'confirming'").all(); } catch { return 0; }
  let expired = 0;
  for (const row of rows) {
    if (!(now - Date.parse(row.updated_at) >= CONFIRM_STALE_MS)) continue;
    const card = row.crm_request_id ? db.prepare('SELECT patient_id FROM crm_requests WHERE id = ?').get(row.crm_request_id) : null;
    const pid = card ? card.patient_id : null;
    const visit = pid && row.doctor_id
      ? db.prepare("SELECT * FROM visits WHERE patient_id = ? AND doctor_id = ? AND status NOT IN ('cancelled', 'no_show') ORDER BY id DESC")
        .all(pid, row.doctor_id).find((v) => Date.parse(v.visit_date) === Date.parse(row.start_at)) || null
      : null;
    db.transaction(() => {
      if (visit) {
        releaseHolds(db, row.id, 'confirmed', now);
        const out = setStatus(db, row.id, { status: 'confirmed', visit_id: visit.id, patient_id: pid }, now);
        enqueueEvent(db, { request: out, event: EV.confirmed, status: 'confirmed',
          details: { doctor_id: out.doctor_id, branch_id: out.branch_id, start: partnerTime(visit.visit_date) }, now, kekPath });
      } else if (liveHoldOf(db, row.id, now)) {
        setStatus(db, row.id, { status: 'pending' }, now);
      } else {
        releaseHolds(db, row.id, 'expired', now);
        const out = setStatus(db, row.id, { status: 'expired', decline_reason: 'expired' }, now);
        enqueueEvent(db, { request: out, event: EV.declined, status: 'expired', details: { reason: 'expired', doctor_id: out.doctor_id }, now, kekPath });
        expired += 1;
      }
    })();
    // Повторная проверка 8a (по желанию): обрыв случился внутри записи в чужое
    // здание — ДО того, как ensure_visit связал визит с карточкой CRM и завёл
    // строки по заявке. Доводим тем же путём, что ensure_visit: связь и зеркало
    // (обе не бросают и повтор не удваивают).
    if (visit) {
      crmLinkVisit(db, visit.id, SYSTEM_BOOKER, { undated: true });
      mirrorVisit(db, visit.id, { actorId: null });
    }
  }
  return expired;
}

/**
 * Истечение: удержание вышло, а регистратор не ответил — время уже свободно
 * (holds.js), здесь записывается итог и партнёр получает отказ «expired».
 * Подтверждаемые в эту секунду (confirming) не трогаются; прерванные (дольше
 * CONFIRM_STALE_MS) — доводятся или возвращаются (M1).
 * @returns {number} сколько заявок истекло
 */
export function expireDue(db, { now = Date.now(), kekPath = null } = {}) {
  let rows = [];
  try { rows = db.prepare("SELECT * FROM api_requests WHERE status IN ('pending', 'offered')").all(); } catch { return 0; }
  let n = recoverConfirming(db, { now, kekPath });
  const sync = (() => { try { return db.prepare('SELECT last_poll_at, inbox_read_at FROM api_sync_state WHERE id = 1').get() || {}; } catch { return {}; } })();
  for (const row of rows) {
    if (holdState(row, now) !== 'expired' || liveHoldOf(db, row.id, now)) continue;
    // Ревью 8a, M2: встречное предложение ждёт ответа ПАРТНЁРА, а ответ лежит в
    // очереди публичного сервера. Пока обмен работает (уже опрашивал сервер), не
    // истекать, пока сбор очереди после срока предложения не прошёл: иначе
    // партнёр получил бы «истекло», а следом — согласие, данное вовремя.
    // Повторная проверка 8a, п. 3: судит миг ЧТЕНИЯ очереди без застрявшего
    // элемента (inbox_read_at), а не конец такта; и ждать ответа есть смысл,
    // только пока предложенное время впереди.
    if (row.status === 'offered' && sync.last_poll_at && Date.parse(row.offered_start) > now
      && !(sync.inbox_read_at && sync.inbox_read_at >= row.offer_until)) continue;
    expireRow(db, row, { now, kekPath });
    n += 1;
  }
  return n;
}

/** Заявка истекла: удержание снято, итог записан, партнёру — отказ «expired». */
function expireRow(db, row, { now, kekPath }) {
  db.transaction(() => {
    releaseHolds(db, row.id, 'expired', now);
    const out = setStatus(db, row.id, { status: 'expired', decline_reason: 'expired' }, now);
    enqueueEvent(db, { request: out, event: EV.declined, status: 'expired', details: { reason: 'expired', doctor_id: out.doctor_id }, now, kekPath });
  })();
}

// ─── ОТВЕТЫ ПАРТНЁРА ────────────────────────────────────────────────────────

/**
 * Отмена пациентом у партнёра (DELETE /appointments/{id}). Ждущая — время
 * освобождается. Записанная до прихода и без работы — визит отменяется той же
 * дверью календаря; с работой — визит не трогается, карточка говорит «партнёр
 * сообщил об отмене» (решает регистратура).
 */
/**
 * Ревью 8a, I7: держит ли визит и чужую запись — живую строку или привязку
 * другой карточки CRM. Такой визит отмена партнёром не отменяет целиком.
 */
function visitCarriesOther(db, visitId, crmRequestId) {
  const own = crmRequestId || 0;
  if (db.prepare("SELECT 1 FROM crm_request_services WHERE visit_id = ? AND status <> 'cancelled' AND request_id <> ? LIMIT 1").get(visitId, own)) return true;
  try { return !!db.prepare('SELECT 1 FROM crm_booking_links WHERE visit_id = ? AND request_id <> ?').get(visitId, own); } catch { return false; }
}

async function partnerCancel(db, row, { now, kekPath }) {
  if (['pending', 'offered', 'new', 'accepted'].includes(row.status)) {
    db.transaction(() => {
      releaseHolds(db, row.id, 'cancelled', now);
      setStatus(db, row.id, { status: 'cancelled', partner_cancel_at: isoOf(now) }, now);
    })();
    return { applied: true, id: row.id, status: 'cancelled' };
  }
  if (row.status === 'confirmed' && row.visit_id) {
    const v = db.prepare('SELECT * FROM visits WHERE id = ?').get(row.visit_id);
    let cancelled = false;
    if (v && PRE_ARRIVAL.includes(v.status) && !visitHasWork(db, v.id) && !visitCarriesOther(db, v.id, row.crm_request_id)) {
      // C1: календарь может отказать в отмене — отмена партнёра не должна ронять
      // приём очереди: тогда пометка «решите вручную», как при визите с работой.
      try { await calendarBook(db, { visit_id: v.id, start: v.visit_date, status: 'cancelled' }, SYSTEM_BOOKER); cancelled = true; } catch (e) {
        console.warn('[public-api] заявка', row.public_id, 'визит не отменён календарём:', e && e.message);
      }
    }
    if (cancelled) {
      const out = setStatus(db, row.id, { status: 'cancelled', partner_cancel_at: isoOf(now) }, now);
      enqueueEvent(db, { request: out, event: EV.cancelled, status: 'cancelled', details: { doctor_id: out.doctor_id }, now, kekPath });
      return { applied: true, id: row.id, status: 'cancelled' };
    }
    setStatus(db, row.id, { partner_cancel_at: isoOf(now) }, now);
    return { applied: true, id: row.id, status: row.status, needs_staff: true };
  }
  // Повторная проверка 8a, п. 6: пациент уже пришёл (или «не пришёл») — отменять
  // у партнёра нечего, но и терять отмену нельзя (курсор очереди уйдёт дальше):
  // пометка для регистратуры, визит не трогается.
  if (row.status === 'arrived' || row.status === 'no_show') {
    setStatus(db, row.id, { partner_cancel_at: isoOf(now) }, now);
    return { applied: true, id: row.id, status: row.status, needs_staff: true };
  }
  // Отмена пришла в ту секунду, когда регистратор подтверждает: визит ещё не
  // заведён — отменять нечего, но и терять отмену нельзя (курсор очереди уйдёт
  // дальше). Пометка — окно карточки скажет «решите вручную».
  if (row.status === 'confirming') {
    setStatus(db, row.id, { partner_cancel_at: isoOf(now) }, now);
    return { applied: true, id: row.id, status: row.status, needs_staff: true };
  }
  return { applied: false, id: row.id, status: row.status };
}

/**
 * Партнёр согласился на другое время: заявка снова ждёт подтверждения
 * регистратора — время держится 30 РАБОЧИХ минут клиники от приёма ответа
 * (решения владельца 18–19; встречное предложение до ответа ждало партнёра —
 * 30 обычных минут, offerOtherTime).
 */
function partnerAcceptOffer(db, row, { now, kekPath, answeredAt = null }) {
  // Ревью 8a, M2: судить по тому, когда ответил ПАРТНЁР (публичный сервер принял
  // ответ — received_at), а не когда клиника его забрала: клиника могла быть без
  // связи (решение 19), а фон тем временем записать «истекло». Такое — ещё
  // предложение: ответ, данный в срок, засчитывается.
  const expiredOffer = row.status === 'expired' && row.decline_reason === 'expired' && row.offered_start && row.offer_until;
  if (row.status !== 'offered' && !expiredOffer) return { applied: false, id: row.id, status: row.status };
  // Повторная проверка 8a, п. 3: «истекло» уже ушло партнёру — второго,
  // противоречащего ответа не будет: заявка остаётся истёкшей. Не ушло —
  // снимается вместе с возвратом (или заменяется отказом «время занято»).
  let unsentExpired = null;
  if (expiredOffer) {
    unsentExpired = db.prepare("SELECT id FROM api_outbox WHERE api_request_id = ? AND event = ? AND status = 'expired' AND sent_at IS NULL ORDER BY id DESC LIMIT 1")
      .get(row.id, EV.declined) || null;
    if (!unsentExpired) return { applied: true, id: row.id, status: 'expired' };
  }
  const dropExpired = () => { if (unsentExpired) db.prepare('DELETE FROM api_outbox WHERE id = ? AND sent_at IS NULL').run(unsentExpired.id); };
  const answered = Number.isFinite(answeredAt) ? answeredAt : now;
  const startMs = Date.parse(row.offered_start);
  if (!(answered < Date.parse(row.offer_until)) || !(startMs > now)) {
    if (row.status === 'offered') expireRow(db, row, { now, kekPath });
    return { applied: true, id: row.id, status: 'expired' };
  }
  // Своё удержание (даже истёкшее, но ещё не снятое фоном — клиника была
  // выключена) согласию не мешает.
  const own = db.prepare('SELECT id FROM slot_holds WHERE api_request_id = ? AND released_at IS NULL').get(row.id);
  if (!slotIsFree(db, { doctorId: row.doctor_id, startMs, durationMin: row.duration_minutes, excludeHoldId: own ? own.id : null, now })) {
    // Ответ вовремя, но время за это время заняли (у стойки или другой партнёр).
    db.transaction(() => {
      dropExpired();
      releaseHolds(db, row.id, 'declined', now);
      const out = setStatus(db, row.id, { status: 'declined', decline_reason: 'slot_taken' }, now);
      enqueueEvent(db, { request: out, event: EV.declined, status: 'declined', details: { reason: 'slot_taken', doctor_id: out.doctor_id }, now, kekPath });
    })();
    return { applied: true, id: row.id, status: 'declined' };
  }
  const untilMs = Date.parse(holdUntilFor(isoOf(now), row.offered_start, { openOn: clinicOpenOn(db) }));
  db.transaction(() => {
    dropExpired();
    releaseHolds(db, row.id, 'accepted', now);
    placeHold(db, { doctorId: row.doctor_id, startMs, durationMin: row.duration_minutes, untilMs, apiRequestId: row.id, kind: 'booking' });
    setStatus(db, row.id, { status: 'pending', start_at: row.offered_start, hold_until: isoOf(untilMs), offered_start: null, offer_until: null, decline_reason: '' }, now);
    cardToDay(db, row, localDayOf(db, row.offered_start));   // I5
  })();
  return { applied: true, id: row.id, status: 'pending', hold_until: isoOf(untilMs) };
}

// ─── ДЛЯ ЭКРАНА ─────────────────────────────────────────────────────────────

const NO_ACTIONS = Object.freeze({ confirm: false, offer: false, decline: false, accept: false });

/**
 * Заявки карточки CRM — для окна «Онлайн-запись через API». decide — может ли
 * смотрящий решать (rpc/api-bookings.js; ревью 8a, I2): иначе все действия false.
 */
export function requestsOfCard(db, crmRequestId, now = Date.now(), { decide = true } = {}) {
  const rows = db.prepare(`
    SELECT r.*, c.name AS connection_name, d.full_name AS doctor_name, b.name AS branch_name,
           ct.name AS consultation_name, ct.price AS consultation_price, s.name AS service_name, s.price AS service_price,
           p.full_name AS patient_card_name, p.mrn AS patient_card_mrn
      FROM api_requests r
      LEFT JOIN api_connections c ON c.id = r.connection_id
      LEFT JOIN users d ON d.id = r.doctor_id
      LEFT JOIN branches b ON b.id = r.branch_id
      LEFT JOIN consultation_types ct ON ct.id = r.consultation_type_id
      LEFT JOIN services s ON s.id = r.service_id
      LEFT JOIN patients p ON p.id = r.patient_id
     WHERE r.crm_request_id = ? ORDER BY r.id DESC`).all(crmRequestId);
  // Ревью 8a, M3: консультация — та цена и то имя, что возьмёт касса (своя цена
  // врача, «Бесплатно» и пустая — 0, нет строки — общая цена вида, решения 8 и
  // 13), а не общая цена вида всегда.
  const consult = (r) => consultationFor(db, r.consultation_type_id, r.doctor_id) || { price: Number(r.consultation_price) || 0, name: r.consultation_name || '' };
  // Повторная проверка 8a, п. 5: услуга — та же цена, что поставит касса (своя
  // цена врача, иначе прайс; ярус «первичный»: повторный визит станет ясен,
  // когда выберут карту).
  const servicePrice = (r) => {
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(r.service_id);
    return Math.round(Number(lineUnitPrice(db, { service_id: r.service_id, doctor_id: r.doctor_id, price_tier: 'primary' }, { service })) || 0);
  };
  return rows.map((r) => ({
    id: r.id, public_id: r.public_id, kind: r.kind, status: shownStatus(r, now), partner_status: PARTNER_STATUS[shownStatus(r, now)] || '',
    connection: { id: r.connection_id, name: r.connection_name || '' }, external_id: r.external_id,
    received_at: r.received_at, picked_at: r.picked_at,
    doctor: r.doctor_id ? { id: r.doctor_id, name: r.doctor_name || '' } : null,
    branch: r.branch_id ? { id: r.branch_id, name: r.branch_name || '' } : null,
    what: r.consultation_type_id ? { kind: 'consultation', ...consult(r) }
      : r.service_id ? { kind: 'service', name: r.service_name || '', price: servicePrice(r) } : null,
    start_at: r.start_at, duration_minutes: r.duration_minutes, hold_until: r.hold_until,
    offered_start: r.offered_start, offer_until: r.offer_until, decline_reason: r.decline_reason,
    patient_name: r.patient_name, patient_phone: r.patient_phone, comment: r.comment,
    patient: r.patient_id ? { id: r.patient_id, full_name: r.patient_card_name || '', mrn: r.patient_card_mrn || '' } : null,
    visit_id: r.visit_id, partner_cancel_at: r.partner_cancel_at,
    can: decide ? bookingActions(r, now) : { ...NO_ACTIONS },
  }));
}

const nameKey = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
/** Карты, к которым может относиться заявка: по номеру (общий номер семьи) — с пометкой, совпало ли имя. */
export function cardCandidates(db, id) {
  const row = requestRow(db, id);
  const words = nameKey(row.patient_name);
  // Ревью 8a, M6: «тот же телефон и имя» — только когда в карте есть ВСЕ слова
  // имени из заявки (и их не меньше двух): общая фамилия сына или брата — ещё не
  // то же имя. Порядок — по числу совпавших слов, полное совпадение первым.
  return findPatientsByPhone(db, row.patient_phone, 10).map((p) => {
    const pw = nameKey(p.full_name);
    const hits = words.filter((w) => pw.includes(w)).length;
    const same = words.length >= 2 && hits === words.length;
    return { card: { id: p.id, full_name: p.full_name, mrn: p.mrn || '', date_of_birth: p.date_of_birth || '', why: same ? 'phone_name' : 'phone' }, hits };
  }).sort((a, b) => (a.card.why === b.card.why ? b.hits - a.hits : a.card.why === 'phone_name' ? -1 : 1)).map((x) => x.card);
}

/** Строки онлайн-записи для доски: заявки, ждущие клинику, по карточкам. */
export function boardMarks(db, now = Date.now()) {
  let rows = [];
  try {
    rows = db.prepare(`SELECT r.id, r.crm_request_id, r.kind, r.status, r.start_at, r.hold_until, r.offered_start, r.offer_until,
                              c.name AS connection_name
                         FROM api_requests r LEFT JOIN api_connections c ON c.id = r.connection_id
                        WHERE r.crm_request_id IS NOT NULL AND r.status IN ('new', 'accepted', 'pending', 'confirming', 'offered')
                        ORDER BY r.id`).all();
  } catch { return {}; }
  const out = {};
  for (const r of rows) {
    (out[r.crm_request_id] || (out[r.crm_request_id] = [])).push({
      id: r.id, kind: r.kind, status: shownStatus(r, now), connection_name: r.connection_name || '',
      start_at: r.start_at, hold_until: r.hold_until, offered_start: r.offered_start, offer_until: r.offer_until,
    });
  }
  return out;
}

