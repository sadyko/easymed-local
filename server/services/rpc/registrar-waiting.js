// WAIT_REG_V1 (3.25.0, 2026-11-17) — «ЖДУТ РЕГИСТРАЦИИ»: КОГО СЕГОДНЯ ЖДЁТ СТОЙКА.
//
// Владелец: «in the registrator window we should show the patients that were sent and patients
// for which we created a booking so registrators won't be confused; create a forcing function».
// Решение владельца: запись колл-центра (CRM) выставляется в счёт ПО ПРИХОДУ — при записи счёта
// нет; регистратор нажимает «Оформить по записи», окно визита выставляет счёт ровно на записанные
// услуги, и пациент идёт в кассу.
//
// registrar_waiting({ patient_id?, count_only? }) — ТОЛЬКО ЧТЕНИЕ. Сегодняшний (МЕСТНЫЙ день клиники)
// список ожидаемых пациентов всей клиники, по строке на пациента. Источники:
//   а) ЗАПИСЬ: визит сегодня «Записан» / «Подтверждён» (не «Пришёл», не отменён, не «Не пришёл»)
//      со строками записи — 'added', без счёта, не товар (календарь, колл-центр / CRM —
//      booking-mirror.js insertBookingLine, booking_lines_add, calendar_book; онлайн-запись сайта и
//      партнёров — services/api/bookings.js). Визит, по которому уже выставлен счёт, начата работа
//      или стоит отметка «оформлен» (registrar_registered — регистрация без счёта, решение
//      владельца), — зарегистрирован (оставшиеся строки без счёта — дело кассы, «Ждут счёта»);
//   а′) ЗАПИСЬ БЕЗ УСЛУГИ (решение владельца, ревью): запись календаря (booked_at — время ей ставил
//      calendar_book) без единой живой строки — в списке с «услуга не выбрана»: «Оформить по записи»
//      открывает окно визита на этого пациента и врача, услугу выбирает регистратор;
//   б) АНАЛИЗ «НА ДАТУ»: строка заявки CRM на сегодня, которую визит дня возьмёт (ещё не севшая
//      в визит), — тем же правилом шага A, что у ensure_visit (crm/visit-link.js stepALinesForDay —
//      stepALines всех пациентов дня одним запросом). WAIT_REG_V1 (ревью M4) — и у пациента, уже
//      оформленного сегодня: анализ, добавленный после утренней регистрации, ещё ждёт стойку;
//   в) НАПРАВИЛ ВРАЧ: строка визита сегодня без счёта, на которую направил врач — правило
//      patient_referral_orders (rpc/referral-orders.js DOCTOR_ORDER_SQL: внутренний источник врача
//      или строку завёл врач к другому исполнителю). Визит может быть и «Пришёл» (направили с
//      приёма): пациент уходит из списка, когда строку выставили в счёт; когда регистратор её не
//      оформил с причиной (referral_line_skip — номер строки в журнале, решение владельца, ревью M2);
//      или когда пациента оформили без счёта после того, как строка появилась (отметка
//      registrar_registered позже строки — регистратор её видел в смете).
// Кто остался к концу дня — не пришёл или его не оформили.
//
// WAIT_REG_V1 (ревью M5) — ЗДАНИЕ, КУДА ПАЦИЕНТ ПРИДЁТ. Сеть зданий (CROSS_BRANCH_CALENDAR_V1):
// запись, сделанная здесь к врачу другого здания, помечена cross_branch = буква того здания и уехала
// туда журналом — её ждёт ТО здание, не это. Там она лежит визитом соседа (sync_origin = буква
// автора), и здание приёма узнаётся по приписке врача (users.branch_id → branches.letter: она едет
// справочником) — то же правило, что у календаря (calendar.js: врач, затем пометка, затем автор).
// Счёт по визиту соседа не выставить (BRANCH_MONEY_GUARD_V1): стойка оформляет пациента своим визитом
// дня, и тогда чужая запись считается оформленной.
//
// WAIT_REG_V1 (ревью M6) — НАГРУЗКА. 3000 визитов в день: строки дня — одним запросом по индексу дня
// (INDEXED BY idx_visits_date), признаки визитов (счёт, работа, отметка, партнёр, CRM) — одним
// пакетным запросом по номерам визитов (INDEXED BY idx_crm_req_services_visit: после ANALYZE
// статистика колонки, где почти все строки без визита, уводила планировщик в обход всех строк заявок
// на каждую строку визита — 7,6 с вместо 14 мс), анализы «на дату» — одним запросом (без N+1),
// имена — словарями. count_only — только число (счётчик вкладки): без имён и подписей.
//
// Отдельный RPC, а не cashier_unbilled: тот закрыт ролями смены кассы и показывает строки без
// счёта за 30 дней.
//
// ДОСТУП — стойка: администратор и регистратура (DESK_ROLES, domain/line-referral.js — те, кому
// регистрация на стойке верится и в шаге связи CRM). Плюс ворота данных пациента, как у
// patient_referral_orders (patientDataRefusal): роль, которой клиника закрыла строки визита, их и
// здесь не получает. Остальным — 403.
import { hasAnyRole } from '../roles.js';
import { today, localRangeWhere } from '../domain/day.js';
import { DESK_ROLES } from '../domain/line-referral.js';
import { patientDataRefusal, PATIENT_DATA_DENIED } from '../../db/patient-data-gate.js';
import { stepALinesForDay } from '../crm/visit-link.js';
import { DOCTOR_ORDER_SQL, REFERRER_ID_SQL, NOT_REFUNDED_SQL } from './referral-orders.js';
import { readIdentity } from '../branch-sync/identity.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

/** Роли, которым открыт список (зеркало экрана: patients-hub.js, вкладка «Ждут регистрации»). */
export const WAITING_ROLES = DESK_ROLES;
const PRE_ARRIVAL = ['scheduled', 'confirmed'];
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const idList = (list) => JSON.stringify([...new Set((list || []).map(Number).filter(isPosInt))]);
const IN_IDS = (col) => `${col} IN (SELECT value FROM json_each(?))`;

/** Буква этого здания (null — сеть не настроена / старая база). */
function selfLetter(db) {
  try { const l = readIdentity(db).letter; return l ? String(l).trim().toUpperCase() : null; } catch { return null; }
}

// ЗДАНИЕ ПРИЁМА (ревью M5): свой визит — если запись не уехала в другое здание (cross_branch пуст);
// визит соседа — если его врач приписан к этому зданию. Четыре параметра: буква здания.
const BUILDING_SQL = `(CASE WHEN v.sync_origin IS NULL
        THEN (COALESCE(v.cross_branch, '') = '' OR (? IS NOT NULL AND upper(trim(v.cross_branch)) = ?))
        ELSE (? IS NOT NULL AND EXISTS (SELECT 1 FROM users bu JOIN branches bb ON bb.id = bu.branch_id
                                         WHERE bu.id = v.doctor_id AND upper(trim(bb.letter)) = ?)) END)`;
const buildingParams = (mine) => [mine, mine, mine, mine];

const plan = (explain) => (explain ? 'EXPLAIN QUERY PLAN ' : '');

/** Строки визитов сегодняшнего дня без счёта: записи до прихода и направления врача (а, в). */
function lineRows(db, day, mine, only, explain = false) {
  const range = localRangeWhere('v.visit_date', day, day);
  return db.prepare(plan(explain) + `
    SELECT * FROM (
      SELECT vs.id AS vs_id, vs.visit_id, vs.service_id, vs.consultation_type_id, vs.doctor_id AS line_doctor_id,
             vs.created_by AS line_created_by, vs.created_at AS line_created_at,
             v.patient_id, v.status AS visit_status, v.booked_at, v.visit_date, v.created_by AS visit_created_by,
             v.doctor_id AS visit_doctor_id, v.sync_origin AS visit_origin,
             -- время — местное, тем же правилом SQLite, что и день (domain/day.js), а не часами Node
             CASE WHEN vs.scheduled_at IS NOT NULL AND vs.scheduled_at <> '' THEN strftime('%H:%M', vs.scheduled_at, 'localtime') END AS line_hhmm,
             strftime('%H:%M', v.visit_date, 'localtime') AS visit_hhmm,
             CASE WHEN ${DOCTOR_ORDER_SQL} THEN 1 ELSE 0 END AS doctor_order,
             ${REFERRER_ID_SQL} AS referrer_id, lrs.name AS source_name
        FROM visits v INDEXED BY idx_visits_date
       CROSS JOIN visit_services vs ON vs.visit_id = v.id
        LEFT JOIN users cu ON cu.id = vs.created_by
        LEFT JOIN referral_sources lrs ON lrs.id = vs.referred_by_source_id
       WHERE ${range.sql}
         AND COALESCE(v.status, '') NOT IN ('cancelled', 'no_show')
         AND ${BUILDING_SQL}
         AND (v.sync_origin IS NOT NULL OR vs.sync_origin IS NULL)
         AND vs.status = 'added' AND vs.invoice_item_id IS NULL AND vs.clinic_item_id IS NULL
         AND (vs.service_id IS NOT NULL OR vs.consultation_type_id IS NOT NULL)
         AND ${NOT_REFUNDED_SQL}
         ${only != null ? 'AND v.patient_id = ?' : ''}
    ) x
    WHERE x.visit_status IN ('scheduled', 'confirmed') OR x.doctor_order = 1
    ORDER BY x.visit_date, x.vs_id`).all(...range.params, ...buildingParams(mine), ...(only != null ? [only] : []));
}

/** Записи календаря на сегодня без единой живой строки (а′). */
function barBookingRows(db, day, mine, only, explain = false) {
  const range = localRangeWhere('v.visit_date', day, day);
  return db.prepare(plan(explain) + `
    SELECT v.id AS visit_id, v.patient_id, v.status AS visit_status, v.booked_at, v.visit_date,
           v.created_by AS visit_created_by, v.doctor_id AS visit_doctor_id, v.sync_origin AS visit_origin,
           strftime('%H:%M', v.visit_date, 'localtime') AS visit_hhmm
      FROM visits v INDEXED BY idx_visits_date
     WHERE ${range.sql}
       AND v.status IN ('scheduled', 'confirmed') AND COALESCE(v.booked_at, '') <> ''
       AND ${BUILDING_SQL}
       AND NOT EXISTS (SELECT 1 FROM visit_services x WHERE x.visit_id = v.id AND x.status <> 'cancelled')
       ${only != null ? 'AND v.patient_id = ?' : ''}
     ORDER BY v.visit_date, v.id`).all(...range.params, ...buildingParams(mine), ...(only != null ? [only] : []));
}

/** Признаки визитов одним запросом: счёт, работа, отметка «оформлен», партнёр, запись CRM. */
function visitFacts(db, visitIds, explain = false) {
  const out = new Map();
  if (!visitIds.length) return out;
  const sql = `
    SELECT v.id,
           EXISTS (SELECT 1 FROM invoices ri WHERE ri.visit_id = v.id AND COALESCE(ri.status, '') <> 'void') AS invoiced,
           EXISTS (SELECT 1 FROM visit_services rw WHERE rw.visit_id = v.id
                    AND (rw.status NOT IN ('added', 'cancelled', 'removed') OR rw.clinic_item_id IS NOT NULL)) AS worked,
           (SELECT MAX(ra.created_at) FROM invoice_audit_log ra WHERE ra.visit_id = v.id AND ra.action = 'visit_registered') AS registered_at,
           (SELECT ac.name FROM api_requests ar JOIN api_connections ac ON ac.id = ar.connection_id
             WHERE ar.visit_id = v.id ORDER BY ar.id LIMIT 1) AS partner_name,
           (EXISTS (SELECT 1 FROM crm_request_services cl INDEXED BY idx_crm_req_services_visit
                     WHERE cl.visit_id = v.id AND cl.status <> 'cancelled')
            OR EXISTS (SELECT 1 FROM crm_booking_links bl WHERE bl.visit_id = v.id AND bl.source = 'callcenter')) AS crm_booked
      FROM visits v WHERE ${IN_IDS('v.id')}`;
  if (explain) return db.prepare(plan(true) + sql).all(idList(visitIds));
  for (const r of db.prepare(sql).all(idList(visitIds))) {
    out.set(Number(r.id), {
      registered: Number(r.invoiced) === 1 || Number(r.worked) === 1 || r.registered_at != null,
      registeredAt: r.registered_at || null,
      partner: r.partner_name || null,
      crm: Number(r.crm_booked) === 1,
    });
  }
  return out;
}

/** Пациенты, у которых СВОЙ визит дня уже оформлен (для записей соседнего здания, ревью M5). */
function ownRegistered(db, day, patientIds) {
  if (!patientIds.length) return new Set();
  const range = localRangeWhere('v.visit_date', day, day);
  return new Set(db.prepare(`
    SELECT DISTINCT v.patient_id FROM visits v
     WHERE ${IN_IDS('v.patient_id')} AND ${range.sql}
       AND v.sync_origin IS NULL AND COALESCE(v.status, '') NOT IN ('cancelled', 'no_show')
       AND (v.status NOT IN ('scheduled', 'confirmed')
            OR EXISTS (SELECT 1 FROM invoices ri WHERE ri.visit_id = v.id AND COALESCE(ri.status, '') <> 'void')
            OR EXISTS (SELECT 1 FROM visit_services rw WHERE rw.visit_id = v.id
                        AND (rw.status NOT IN ('added', 'cancelled', 'removed') OR rw.clinic_item_id IS NOT NULL))
            OR EXISTS (SELECT 1 FROM invoice_audit_log ra WHERE ra.visit_id = v.id AND ra.action = 'visit_registered'))`)
    .all(idList(patientIds), ...range.params).map((r) => Number(r.patient_id)));
}

/** Направления врача, которые регистратор не оформил с причиной (номер строки — миграция 287). */
function skippedLines(db, vsIds) {
  if (!vsIds.length) return new Set();
  try {
    return new Set(db.prepare(`SELECT DISTINCT visit_service_id AS id FROM invoice_audit_log
                                WHERE ${IN_IDS('visit_service_id')} AND action = 'line_referral_skipped'`)
      .all(idList(vsIds)).map((r) => Number(r.id)));
  } catch { return new Set(); }   // база до 287 — пропусков нет
}

function parseRoles(raw) {
  if (Array.isArray(raw)) return raw;
  try { const p = JSON.parse(raw || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}

const nameOfUser = (u) => (u ? (String(u.full_name || '').trim() || u.username || '') : '');

/**
 * WAIT_REG_V1 (ревью M6) — ПЛАНЫ ЗАПРОСОВ СПИСКА (EXPLAIN QUERY PLAN тех же текстов, что выполняются):
 * их проверяет тест плана (registrar-waiting-plan.test.js) до и после ANALYZE.
 * @returns {{lines: string[], bare: string[], facts: string[], wishes: string[]}}
 */
export function waitingQueryPlans(db, { visitIds = [1] } = {}) {
  const day = today(db);
  const mine = selfLetter(db);
  const detail = (rows) => (rows || []).map((r) => String(r.detail));
  return {
    lines: detail(lineRows(db, day, mine, null, true)),
    bare: detail(barBookingRows(db, day, mine, null, true)),
    facts: detail(visitFacts(db, visitIds, true)),
    wishes: detail(stepALinesForDay(db, day, { explain: true })),
  };
}

/** registrar_waiting({ patient_id?, count_only? }) → { today, count, rows? } */
export function registrarWaiting(db, args, user) {
  if (!hasAnyRole(user, WAITING_ROLES)) throw new RpcError('Список «Ждут регистрации» доступен регистратуре и администратору.', 403);
  if (patientDataRefusal('visit_services', user, db) || patientDataRefusal('visits', user, db)) {
    throw new RpcError(PATIENT_DATA_DENIED, 403);
  }
  const a = args || {};
  const onlyRaw = a.patient_id == null || a.patient_id === '' ? null : Number(a.patient_id);
  if (onlyRaw != null && !isPosInt(onlyRaw)) throw new RpcError('Пациент указан неверно.', 400);
  const only = onlyRaw;
  const countOnly = a.count_only === true || a.count_only === 'true';
  const day = today(db);
  const mine = selfLetter(db);

  // ── сбор: строки (а, в), записи без услуги (а′), анализы «на дату» (б) ──
  const lines = lineRows(db, day, mine, only);
  const bare = barBookingRows(db, day, mine, only);
  const wishes = stepALinesForDay(db, day, { patientId: only });
  const facts = visitFacts(db, [...lines.map((l) => l.visit_id), ...bare.map((b) => b.visit_id)]);
  const skipped = skippedLines(db, lines.filter((l) => Number(l.doctor_order) === 1).map((l) => l.vs_id));
  const foreignPatients = [...lines, ...bare].filter((x) => x.visit_origin != null).map((x) => x.patient_id);
  const ownDone = ownRegistered(db, day, foreignPatients);
  const doneOf = (x) => {
    const f = facts.get(Number(x.visit_id));
    return !!(f && f.registered) || (x.visit_origin != null && ownDone.has(Number(x.patient_id)));
  };

  // ── отбор: кто ещё ждёт ──
  const keptLines = lines.filter((l) => {
    if (Number(l.doctor_order) === 1) {
      if (skipped.has(Number(l.vs_id))) return false;   // ревью M2 — не оформлено с причиной
      const at = (facts.get(Number(l.visit_id)) || {}).registeredAt;
      return !(at && l.line_created_at && String(at) >= String(l.line_created_at));   // оформлен без счёта после направления
    }
    return PRE_ARRIVAL.includes(l.visit_status) && !doneOf(l);
  });
  const keptBare = bare.filter((b) => !doneOf(b));

  if (countOnly) {
    const who = new Set([...keptLines, ...keptBare, ...wishes].map((x) => Number(x.patient_id)));
    return { today: day, count: who.size };
  }

  // ── подписи: словари одним запросом на таблицу ──
  const pids = [...keptLines, ...keptBare, ...wishes].map((x) => x.patient_id);
  const patients = new Map(pids.length ? db.prepare(`SELECT id, full_name, mrn, phone FROM patients WHERE ${IN_IDS('id')}`).all(idList(pids)).map((p) => [Number(p.id), p]) : []);
  const users = new Map(db.prepare('SELECT id, username, full_name, role, extra_roles FROM users').all().map((u) => [Number(u.id), u]));
  // Ревью L6 — колл-центр и по «Дополнительным ролям».
  const isCallcenter = (uid) => {
    const u = uid != null ? users.get(Number(uid)) : null;
    return !!u && (u.role === 'callcenter' || parseRoles(u.extra_roles).includes('callcenter'));
  };
  const svcIds = [...keptLines, ...wishes].map((x) => x.service_id).filter((v) => v != null);
  const ctIds = [...keptLines, ...wishes].filter((x) => x.service_id == null).map((x) => x.consultation_type_id).filter((v) => v != null);
  const services = new Map(svcIds.length ? db.prepare(`SELECT id, name FROM services WHERE ${IN_IDS('id')}`).all(idList(svcIds)).map((s) => [Number(s.id), s.name || '']) : []);
  const consults = new Map(ctIds.length ? db.prepare(`SELECT id, COALESCE(name_ru, name) AS name FROM consultation_types WHERE ${IN_IDS('id')}`).all(idList(ctIds)).map((s) => [Number(s.id), s.name || '']) : []);
  const reqIds = [...new Set(wishes.map((w) => Number(w.request_id)))];
  const partnerOfCard = new Map();
  if (reqIds.length) {
    try {
      for (const r of db.prepare(`SELECT ar.crm_request_id AS rid, ac.name FROM api_requests ar JOIN api_connections ac ON ac.id = ar.connection_id
                                   WHERE ${IN_IDS('ar.crm_request_id')} ORDER BY ar.id`).all(idList(reqIds))) {
        if (!partnerOfCard.has(Number(r.rid))) partnerOfCard.set(Number(r.rid), r.name || null);
      }
    } catch { /* база без подключений API — партнёров нет */ }
  }
  const lineName = (x) => (x.service_id != null ? services.get(Number(x.service_id)) : consults.get(Number(x.consultation_type_id))) || '';

  const rows = new Map();   // patient_id → строка ответа
  const rowOf = (pid) => {
    const id = Number(pid);
    let r = rows.get(id);
    if (!r) {
      const p = patients.get(id) || {};
      r = { patient_id: id, patient_name: p.full_name || '', mrn: p.mrn || '', phone: p.phone || '',
        time: null, visit_id: null, visit_status: null, no_service: false, sources: [], doctors: [], services: [], booked_by: [], lines: [] };
      rows.set(id, r);
    }
    return r;
  };
  const addUnique = (list, v) => { if (v && !list.includes(v)) list.push(v); };
  const addSource = (r, kind, name = '') => {
    if (!r.sources.some((s) => s.kind === kind && (s.name || '') === (name || ''))) r.sources.push({ kind, name: name || '' });
  };
  const earlier = (r, t) => { if (t && (!r.time || t < r.time)) r.time = t; };
  const bookingSource = (x) => {
    const f = facts.get(Number(x.visit_id)) || {};
    if (f.partner) return ['partner', f.partner];
    if (f.crm || isCallcenter(x.visit_created_by) || isCallcenter(x.line_created_by)) return ['crm', ''];
    return ['calendar', ''];
  };
  // Время записи (booked_at — его ставил calendar_book); у визита дня без записи времени нет.
  const visitTime = (x) => (String(x.booked_at || '').trim() ? (x.visit_hhmm || null) : null);

  for (const l of keptLines) {
    const doctor = Number(l.doctor_order) === 1;
    const r = rowOf(l.patient_id);
    if (r.visit_id == null) { r.visit_id = Number(l.visit_id); r.visit_status = l.visit_status; }
    const [source, partner] = doctor ? ['doctor', ''] : bookingSource(l);
    const referrer = doctor ? (nameOfUser(users.get(Number(l.referrer_id))) || l.source_name || '') : '';
    addSource(r, source, source === 'doctor' ? referrer : partner);
    // Время строки (своё, не полночь «на дату»), иначе время записи.
    const lineTime = l.line_hhmm && l.line_hhmm !== '00:00' ? l.line_hhmm : null;
    const time = lineTime || visitTime(l);
    earlier(r, time);
    const name = lineName(l);
    // Врач строки; у строки соседнего здания его нет (журнал везёт врача только визита) — врач визита.
    const lineDoctor = l.line_doctor_id ?? (l.visit_origin != null ? l.visit_doctor_id : null);
    const doctorName = nameOfUser(users.get(Number(lineDoctor)));
    addUnique(r.services, name);
    addUnique(r.doctors, doctorName);
    addUnique(r.booked_by, doctor ? nameOfUser(users.get(Number(l.line_created_by)))
      : (nameOfUser(users.get(Number(l.visit_created_by))) || nameOfUser(users.get(Number(l.line_created_by)))));
    r.lines.push({ kind: doctor ? 'doctor' : 'booked', visit_service_id: Number(l.vs_id), visit_id: Number(l.visit_id),
      service_id: l.service_id ?? null, consultation_type_id: l.service_id == null ? (l.consultation_type_id ?? null) : null,
      doctor_id: lineDoctor ?? null, name, doctor_name: doctorName, source, time,
      referrer_name: referrer, foreign: l.visit_origin != null });
  }

  for (const b of keptBare) {
    const r = rowOf(b.patient_id);
    if (r.visit_id == null) { r.visit_id = Number(b.visit_id); r.visit_status = b.visit_status; }
    const [source, partner] = bookingSource(b);
    addSource(r, source, partner);
    const time = visitTime(b);
    earlier(r, time);
    const doctorName = nameOfUser(users.get(Number(b.visit_doctor_id)));
    addUnique(r.doctors, doctorName);
    addUnique(r.booked_by, nameOfUser(users.get(Number(b.visit_created_by))));
    r.lines.push({ kind: 'booking', visit_service_id: null, visit_id: Number(b.visit_id), service_id: null, consultation_type_id: null,
      doctor_id: b.visit_doctor_id ?? null, name: '', doctor_name: doctorName, source, time, referrer_name: '', foreign: b.visit_origin != null });
  }

  for (const w of wishes) {
    const r = rowOf(w.patient_id);
    if (r.visit_id == null && w.day_visit_id != null) { r.visit_id = Number(w.day_visit_id); }
    const partner = partnerOfCard.get(Number(w.request_id)) || null;
    const source = partner ? 'partner' : 'crm';
    addSource(r, source, partner || '');
    const name = lineName(w);
    const doctorName = w.doctor_id != null ? nameOfUser(users.get(Number(w.doctor_id))) : '';
    addUnique(r.services, name);
    addUnique(r.doctors, doctorName);
    addUnique(r.booked_by, nameOfUser(users.get(Number(w.assigned_to != null ? w.assigned_to : w.card_created_by))));
    r.lines.push({ kind: 'wish', crm_line_id: Number(w.id), request_id: Number(w.request_id),
      service_id: w.service_id ?? null, consultation_type_id: w.service_id == null ? (w.consultation_type_id ?? null) : null,
      doctor_id: w.doctor_id ?? null, name, doctor_name: doctorName, source, time: null, referrer_name: '' });
  }

  // Пациент только с анализом «на дату» и визитом дня — статус этого визита (одним запросом).
  const statusOf = [...rows.values()].filter((r) => r.visit_status == null && r.visit_id != null).map((r) => r.visit_id);
  const visitStatus = new Map(statusOf.length ? db.prepare(`SELECT id, status FROM visits WHERE ${IN_IDS('id')}`).all(idList(statusOf)).map((v) => [Number(v.id), v.status]) : []);
  for (const r of rows.values()) {
    r.no_service = r.lines.length > 0 && r.lines.every((l) => l.kind === 'booking');
    if (r.visit_status == null && r.visit_id != null) r.visit_status = visitStatus.get(Number(r.visit_id)) ?? null;
  }
  const byName = new Intl.Collator('ru');   // ревью M6 — один сборщик на сортировку, а не localeCompare(…, 'ru') на каждое сравнение
  const out = [...rows.values()].sort((x, y) => {
    if (x.time && y.time && x.time !== y.time) return x.time < y.time ? -1 : 1;
    if (!!x.time !== !!y.time) return x.time ? -1 : 1;
    return byName.compare(String(x.patient_name), String(y.patient_name)) || x.patient_id - y.patient_id;
  });
  return { today: day, count: out.length, rows: out };
}
