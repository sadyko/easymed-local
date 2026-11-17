// WAIT_REG_V1 (ревью, 3.25.0, 2026-11-17) — ДВЕРИ СТОЙКИ ПРИ РЕГИСТРАЦИИ: ЧТО НЕ ОФОРМЛЕНО И ПОЧЕМУ,
// И ЧТО ПАЦИЕНТ ОФОРМЛЕН. Всё — на сервере, одной транзакцией с журналом (invoice_audit_log), а не
// из браузера через /api/db (ревью L4) и не двумя вызовами окна, между которыми остаётся полусостояние
// (ревью H1, L1).
//
//   crm_wish_release { crm_line_id, patient_id, reason } — АНАЛИЗ «НА ДАТУ» (строка заявки CRM на
//     сегодня, или «когда придёт» без даты), который регистратор убрал из сметы с причиной, отпускается
//     ДО ensure_visit: без даты, без визита, с отметкой «отпущена» (released_from_visit_id — правило O4
//     crm/one-way.js: сама она ни в какой визит не садится, пока оператор не назначит ей день), и
//     причина — в журнале. Прежде окно звало ensure_visit, искало севшую строку и снимало её
//     booking_line_remove; у пациента со счётом строка не садилась (I5: держала визит без строки),
//     окно «успешно» не находило её, и «пришёл сейчас» сажал её обратно без счёта, закрывая строку
//     заявки «done» (ревью H1). Отпускается только строка, которую визит дня СЕЙЧАС взял бы (шаг A —
//     crm/visit-link.js stepALines, то же правило, что у ensure_visit и сметы crm_day_lines): иначе —
//     отказ словами (409), а не «успех».
//   referral_line_skip { visit_service_id, reason } — направление врача, которое регистратор не
//     оформил: строка остаётся в визите (её назначил врач), причина — в журнале с номером строки
//     визита (миграция 287). По этому номеру «Ждут регистрации» больше не держит пациента ради неё
//     (решение владельца, ревью M2). Только строка, которая и есть направление врача (правило
//     patient_referral_orders, DOCTOR_ORDER_SQL), без счёта.
//   registrar_registered { visit_id } — ОТМЕТКА «ОФОРМЛЕН» окна визита, когда счёт не выставлялся
//     (галочка «Сразу выставить счёт» снята): пациент уходит из «Ждут регистрации», строки без счёта
//     ждут кассу («Ждут счёта»). Решение владельца. Отметка — строка журнала визита ('visit_registered'),
//     одна на визит; только сегодняшний живой визит своего здания.
//
// ДОСТУП — стойка (администратор, регистратура; DESK_ROLES — те же, что у «Ждут регистрации») и ворота
// данных пациента (как у registrar_waiting). Все три — запись: при просроченной лицензии закрыты
// (control/gate.js — их нет в READ_ONLY_RPCS).
import { hasAnyRole } from '../roles.js';
import { today, localDate } from '../domain/day.js';
import { DESK_ROLES } from '../domain/line-referral.js';
import { patientDataRefusal, PATIENT_DATA_DENIED } from '../../db/patient-data-gate.js';
import { dayVisitOf } from './visits.js';
import { stepALines } from '../crm/visit-link.js';
import { touchRequest } from '../crm/booking-mirror.js';
import { DOCTOR_ORDER_SQL, REFERRER_ID_SQL } from './referral-orders.js';
import { actingActorName } from '../../../public/js/shared/act-as.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export const REASON_MIN = 3;
export const REASON_MAX = 500;
const isPosInt = (v) => Number.isInteger(v) && v > 0;

/** Причина регистратора: обязательна, не короче трёх знаков (как у экстренной записи и повтора). */
export function requiredReason(args) {
  const r = args && typeof args.reason === 'string' ? args.reason.trim() : '';
  if (r.length < REASON_MIN) throw new RpcError('Укажите причину: не короче трёх знаков.', 400);
  return r.slice(0, REASON_MAX);
}

function deskGate(db, user, refusal) {
  if (!hasAnyRole(user, DESK_ROLES)) throw new RpcError(refusal, 403);
  if (patientDataRefusal('visit_services', user, db) || patientDataRefusal('visits', user, db)) {
    throw new RpcError(PATIENT_DATA_DENIED, 403);
  }
}

/**
 * Строка журнала правок строк визита (invoice_audit_log) от имени сотрудника — в транзакции
 * вызывающего. vsId — номер строки визита (миграция 287) или null.
 */
export function journalLine(db, { visitId = null, vsId = null, action, reason = null, notes = null }, user) {
  const actor = user && user.id != null ? db.prepare('SELECT id, full_name, role FROM users WHERE id = ?').get(user.id) : null;
  db.prepare(`INSERT INTO invoice_audit_log (visit_id, visit_service_id, action, actor_user_id, actor_name, actor_role, reason, notes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(visitId, vsId, action, actor ? actor.id : null, actor ? actingActorName(user, actor.full_name || null) : null,
      actor ? actor.role || null : null, reason, notes);
}

/** Название услуги строки (услуга каталога или вид приёма). */
export function lineServiceName(db, row) {
  const svc = row && row.service_id != null ? db.prepare('SELECT name FROM services WHERE id = ?').get(row.service_id)
    : row && row.consultation_type_id != null ? db.prepare('SELECT COALESCE(name_ru, name) AS name FROM consultation_types WHERE id = ?').get(row.consultation_type_id) : null;
  return (svc && svc.name) || '—';
}

// CRM_BOOKINGS_TAB_V1 — ТЕКСТ ЖУРНАЛА «АНАЛИЗ ОТПУЩЕН СТОЙКОЙ» — В ОДНОМ МЕСТЕ С ЕГО РАЗБОРОМ. «Записи CRM»
// (rpc/registrar-waiting.js, статус «Отменены») находят отпущенный анализ по этой строке журнала:
// номера строки заявки в журнале нет, а у отпущенной строки дата снята, — пациент и услуга берутся из
// номера заявки и названия в тексте. Текст в базе прежний, слово в слово.
/* i18n-exempt-start: строка журнала ПИШЕТСЯ В БАЗУ, а не рисуется */
export function wishReleaseNotes(name, requestId) {
  return `Услуга «${name}» заявки № ${requestId} снята регистратурой и возвращена в заявку без даты`;
}
const WISH_RELEASE_RE = /^Услуга «(.*)» заявки № (\d+) снята регистратурой/;
/* i18n-exempt-end */
/** Разбор wishReleaseNotes → { name, requestId } или null (чужой текст). */
export function parseWishReleaseNotes(notes) {
  const m = WISH_RELEASE_RE.exec(String(notes || ''));
  return m ? { name: m[1], requestId: Number(m[2]) } : null;
}

/** crm_wish_release { crm_line_id, patient_id, reason } → { released: true, id, request_id } */
export function crmWishRelease(db, args, user) {
  deskGate(db, user, 'Вернуть услугу в заявку при регистрации может регистратура или администратор.');
  const lineId = Number(args && args.crm_line_id);
  const patientId = Number(args && args.patient_id);
  if (!isPosInt(lineId)) throw new RpcError('Не выбрана услуга заявки.', 400);
  if (!isPosInt(patientId)) throw new RpcError('Пациент указан неверно.', 400);
  const reason = requiredReason(args);
  return db.transaction(() => {
    const line = db.prepare(`SELECT l.*, r.patient_id AS card_patient FROM crm_request_services l
                               JOIN crm_requests r ON r.id = l.request_id WHERE l.id = ?`).get(lineId);
    if (!line) throw new RpcError('Услуга заявки не найдена.', 404);
    if (line.card_patient == null || Number(line.card_patient) !== patientId) {
      throw new RpcError('Это услуга заявки другого пациента — вернуть её отсюда нельзя.', 400);
    }
    // Только то, что визит дня сейчас взял бы (шаг A, с «без даты» — как у ensure_visit).
    const day = today(db);
    const dv = dayVisitOf(db, patientId, day);
    const taken = stepALines(db, { patientId, day, visitId: dv ? dv.id : null, undated: true })
      .some(({ lines }) => lines.some((l) => Number(l.id) === lineId));
    if (!taken) {
      throw new RpcError('Услуга заявки уже не ждёт сегодняшнего визита: её записали, вернули или закрыли — откройте окно визита заново.', 409);
    }
    // Держала живой визит без строки визита (I5) — отпущена этим визитом; иначе визита у неё не было (0).
    const heldVisit = line.visit_id != null && dv && Number(line.visit_id) === Number(dv.id) ? Number(dv.id) : null;
    db.prepare(`UPDATE crm_request_services
                   SET scheduled_date = NULL, visit_id = NULL, visit_service_id = NULL, visit_service_auto = 0,
                       released_from_visit_id = ?, released_vs_id = NULL, released_held = 0
                 WHERE id = ?`).run(heldVisit ?? 0, lineId);
    const name = lineServiceName(db, line);
    journalLine(db, { visitId: heldVisit ?? (dv ? Number(dv.id) : null), action: 'line_wish_released', reason,
      notes: wishReleaseNotes(name, line.request_id) }, user);   // CRM_BOOKINGS_TAB_V1 — текст прежний
    touchRequest(db, line.request_id);
    return { released: true, id: lineId, request_id: Number(line.request_id) };
  })();
}

/** referral_line_skip { visit_service_id, reason } → { skipped: true, id } */
export function referralLineSkip(db, args, user) {
  deskGate(db, user, 'Не оформить направление врача может регистратура или администратор.');
  const id = Number(args && args.visit_service_id);
  if (!isPosInt(id)) throw new RpcError('Не выбрана строка направления.', 400);
  const reason = requiredReason(args);
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT vs.*, v.status AS visit_status, v.sync_origin AS visit_origin,
             CASE WHEN ${DOCTOR_ORDER_SQL} THEN 1 ELSE 0 END AS doctor_order,
             COALESCE(NULLIF(ru.full_name, ''), ru.username, lrs.name, '') AS referrer_name
        FROM visit_services vs
        JOIN visits v ON v.id = vs.visit_id
        LEFT JOIN users cu ON cu.id = vs.created_by
        LEFT JOIN referral_sources lrs ON lrs.id = vs.referred_by_source_id
        LEFT JOIN users ru ON ru.id = ${REFERRER_ID_SQL}
       WHERE vs.id = ?`).get(id);
    if (!row) throw new RpcError('Строка направления не найдена.', 404);
    if (row.sync_origin != null || row.visit_origin != null) throw new RpcError('Строка заведена в другом здании — её оформляют там.', 400);
    if (['cancelled', 'no_show'].includes(row.visit_status)) throw new RpcError('Визит отменён — направление не ждёт регистрации.', 400);
    if (Number(row.doctor_order) !== 1) throw new RpcError('Это не направление врача.', 400);
    if (row.invoice_item_id != null || row.status !== 'added') throw new RpcError('Направление уже в счёте или в работе.', 400);
    const name = lineServiceName(db, row);
    /* i18n-exempt-start: строка журнала ПИШЕТСЯ В БАЗУ, а не рисуется */
    journalLine(db, { visitId: Number(row.visit_id), vsId: id, action: 'line_referral_skipped', reason,
      notes: `Направление врача не оформлено: «${name}» (направил ${row.referrer_name || '—'}), строка визита № ${id}` }, user);
    /* i18n-exempt-end */
    return { skipped: true, id };
  })();
}

/** registrar_registered { visit_id } → { registered: true, visit_id, already } */
export function registrarRegistered(db, args, user) {
  deskGate(db, user, 'Отметить регистрацию может регистратура или администратор.');
  const visitId = Number(args && args.visit_id);
  if (!isPosInt(visitId)) throw new RpcError('Не выбран визит.', 400);
  return db.transaction(() => {
    const v = db.prepare(`SELECT id, status, sync_origin, ${localDate('visit_date')} AS day FROM visits WHERE id = ?`).get(visitId);
    if (!v) throw new RpcError('Визит не найден.', 404);
    if (v.sync_origin != null) throw new RpcError('Визит заведён в другом здании — его оформляют там.', 400);
    if (['cancelled', 'no_show'].includes(v.status)) throw new RpcError('Визит отменён — оформлять нечего.', 400);
    if (v.day !== today(db)) throw new RpcError('Отметить регистрацию можно только у сегодняшнего визита.', 400);
    if (db.prepare("SELECT 1 FROM invoice_audit_log WHERE visit_id = ? AND action = 'visit_registered' LIMIT 1").get(visitId)) {
      return { registered: true, visit_id: visitId, already: true };
    }
    /* i18n-exempt-start: строка журнала ПИШЕТСЯ В БАЗУ, а не рисуется */
    journalLine(db, { visitId, action: 'visit_registered', notes: 'Пациент оформлен у стойки без счёта — строки ждут кассу' }, user);
    /* i18n-exempt-end */
    return { registered: true, visit_id: visitId, already: false };
  })();
}
