// WAIT_REG_V1 (3.25.0, 2026-11-17) — «ЖДУТ РЕГИСТРАЦИИ»: КОГО СЕГОДНЯ ЖДЁТ СТОЙКА.
//
// Владелец: «in the registrator window we should show the patients that were sent and patients
// for which we created a booking so registrators won't be confused; create a forcing function».
// Решение владельца: запись колл-центра (CRM) выставляется в счёт ПО ПРИХОДУ — при записи счёта
// нет; регистратор нажимает «Оформить по записи», окно визита выставляет счёт ровно на записанные
// услуги, и пациент идёт в кассу.
//
// registrar_waiting({ patient_id?, count_only?, day? | from?+to?, sources?, status?, doctor_id?, q? })
// — ТОЛЬКО ЧТЕНИЕ. Без фильтров — сегодняшний (МЕСТНЫЙ день клиники) список ожидаемых пациентов всей
// клиники, по строке на пациента. Источники:
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
// CRM_BOOKINGS_TAB_V1 (3.25.0, 2026-11-17) — «ЗАПИСИ CRM»: ТОТ ЖЕ СПИСОК С ФИЛЬТРАМИ. Решение владельца
// (с макета): регистратор видит записи, не выбирая врача, кабинет или услугу. Вкладка стала списком
// записей с фильтрами; правило «ждёт» выше — НЕ МЕНЯЛОСЬ (без фильтров ответ прежний, слово в слово, и
// его стерегут прежние тесты). Строка ответа — пациент + день + статус (у пациента в «Все» может быть
// две строки дня: «Оформлен» утром и «Ждёт» анализ, добавленный после). Фильтры:
//   • день — day ('ГГГГ-ММ-ДД') или период from…to (не больше 7 дней); по умолчанию — сегодня.
//     Прошлые дни можно (кто не пришёл);
//   • sources[] — 'crm' | 'calendar' | 'partner' | 'doctor'; пусто — все. Строка с несколькими
//     источниками подходит, если подходит любой;
//   • status — точные правила:
//       'waiting' (по умолчанию) — правило «ждёт» выше на день сегодня и позже;
//       'no_show' — визит «Не пришёл» (запись), и всё, что на ПРОШЛЫЙ день по правилу «ждёт» так и
//         осталось неоформленным (запись, анализ «на дату», направление врача);
//       'registered' — запись (время записи, связь с CRM или с онлайн-записью партнёра), по которой
//         выставлен счёт, начата работа, стоит отметка «оформлен» или визит уже «Пришёл» и дальше
//         (здание приёма — правило ревью M5), и выставленные / оформленные направления врача.
//         Приход «с улицы» (визит стойки без записи) — не запись, его здесь нет;
//       'cancelled' — отменённая запись (визит «Отменён»), отменённая оператором строка заявки на этот
//         день, анализ «на дату», отпущенный стойкой с причиной (crm_wish_release — журнал), и
//         направление врача, не оформленное с причиной (referral_line_skip — журнал); причина — reasons;
//       'all' — все четыре;
//   • doctor_id — строки, где этот врач у строки записи, записи без услуги или анализа «на дату»
//     (те же врачи, что в «Врач:» строки); список врачей фильтра — doctors (is_doctor или роль «Врач»,
//     действующие);
//   • q — имя, телефон (и цифрами), номер карты — правилом поиска кассы (cashier.js patientMatchSql).
// count_only — число строк при тех же фильтрах (счётчик вкладки спрашивает его с фильтром по
// умолчанию экрана). Порядок строк — по дню, затем по времени; «за день» (анализ на дату без времени)
// — после строк со временем, по имени.
//
// WAIT_REG_V1 (ревью M5) — ЗДАНИЕ, КУДА ПАЦИЕНТ ПРИДЁТ. Сеть зданий (CROSS_BRANCH_CALENDAR_V1):
// запись, сделанная здесь к врачу другого здания, помечена cross_branch = буква того здания и уехала
// туда журналом — её ждёт ТО здание, не это. Там она лежит визитом соседа (sync_origin = буква
// автора), и здание приёма узнаётся по приписке врача (users.branch_id → branches.letter: она едет
// справочником) — то же правило, что у календаря (calendar.js: врач, затем пометка, затем автор).
// Счёт по визиту соседа не выставить (BRANCH_MONEY_GUARD_V1): стойка оформляет пациента своим визитом
// дня, и тогда чужая запись считается оформленной. CRM_BOOKINGS_TAB_V1 — то же правило у всех статусов.
//
// WAIT_REG_V1 (ревью M6) — НАГРУЗКА. 3000 визитов в день: строки дня — одним запросом по индексу дня
// (INDEXED BY idx_visits_date), признаки визитов (счёт, работа, отметка, партнёр, CRM) — одним
// пакетным запросом по номерам визитов (INDEXED BY idx_crm_req_services_visit: после ANALYZE
// статистика колонки, где почти все строки без визита, уводила планировщик в обход всех строк заявок
// на каждую строку визита — 7,6 с вместо 14 мс), анализы «на дату» — одним запросом (без N+1),
// имена — словарями. count_only — только число (счётчик вкладки): без имён и подписей.
// CRM_BOOKINGS_TAB_V1 — статусы кроме «Ждут» читают визиты периода тем же индексом дня, их строки — по
// визиту, отменённые строки заявок — по индексу даты, журнал отпущенных — по индексу визита; поиск —
// только среди пациентов найденных строк (по ключу). Статус «Ждут» этих чтений не делает.
//
// Отдельный RPC, а не cashier_unbilled: тот закрыт ролями смены кассы и показывает строки без
// счёта за 30 дней.
//
// ДОСТУП — стойка: администратор и регистратура (DESK_ROLES, domain/line-referral.js — те, кому
// регистрация на стойке верится и в шаге связи CRM). Плюс ворота данных пациента, как у
// patient_referral_orders (patientDataRefusal): роль, которой клиника закрыла строки визита, их и
// здесь не получает. Остальным — 403. Неверные фильтры — 400 словами.
import { hasAnyRole } from '../roles.js';
import { today, localRangeWhere, localDate } from '../domain/day.js';
import { DESK_ROLES } from '../domain/line-referral.js';
import { patientDataRefusal, PATIENT_DATA_DENIED } from '../../db/patient-data-gate.js';
import { stepALinesForDay } from '../crm/visit-link.js';
import { DOCTOR_ORDER_SQL, REFERRER_ID_SQL, NOT_REFUNDED_SQL } from './referral-orders.js';
import { readIdentity } from '../branch-sync/identity.js';
import { searchArg } from './page-args.js';                   // CRM_BOOKINGS_TAB_V1 — строка поиска: не текст / длиннее 200 — 400
import { patientMatchSql } from './cashier.js';               // CRM_BOOKINGS_TAB_V1 — поиск пациента правилом кассы
import { parseWishReleaseNotes } from './registrar-desk.js';  // CRM_BOOKINGS_TAB_V1 — отпущенный стойкой анализ (журнал)

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

/** Роли, которым открыт список (зеркало экрана: patients-hub.js, вкладка «Записи CRM»). */
export const WAITING_ROLES = DESK_ROLES;
const PRE_ARRIVAL = ['scheduled', 'confirmed'];
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const idList = (list) => JSON.stringify([...new Set((list || []).map(Number).filter(isPosInt))]);
const IN_IDS = (col) => `${col} IN (SELECT value FROM json_each(?))`;

// CRM_BOOKINGS_TAB_V1 — словарь фильтров (зеркало экрана: views/registrar-waiting.js).
export const SOURCE_KINDS = Object.freeze(['crm', 'calendar', 'partner', 'doctor']);
export const STATUS_KINDS = Object.freeze(['waiting', 'no_show', 'registered', 'cancelled']);
export const MAX_RANGE_DAYS = 7;
const STATUS_ORDER = Object.freeze({ waiting: 0, no_show: 1, registered: 2, cancelled: 3 });

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

// ─── CRM_BOOKINGS_TAB_V1: даты фильтра — календарной арифметикой строк 'ГГГГ-ММ-ДД' (без часов Node) ───
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayNum = (s) => { const [y, m, d] = String(s).split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const ymdOf = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
function isYmd(s) {
  if (typeof s !== 'string' || !YMD_RE.test(s)) return false;
  return ymdOf(dayNum(s)) === s;   // 2026-02-30 → 2026-03-02 ≠ — не дата
}
function daysOf(from, to) {
  const out = [];
  for (let n = dayNum(from); n <= dayNum(to); n++) out.push(ymdOf(n));
  return out;
}
const blank = (v) => v === undefined || v === null || v === '';

/**
 * CRM_BOOKINGS_TAB_V1 — фильтры из аргументов; неверное — 400 словами.
 * @returns {{from: string, to: string, sources: Set<string>|null, status: string, doctorId: number|null, q: string}}
 */
function parseFilter(a, day0) {
  const hasDay = !blank(a.day);
  const hasRange = !blank(a.from) || !blank(a.to);
  if (hasDay && hasRange) throw new RpcError('Укажите либо день, либо период — не оба сразу.', 400);
  let from = day0;
  let to = day0;
  if (hasDay) {
    if (!isYmd(a.day)) throw new RpcError('День указан неверно: нужна дата вида ГГГГ-ММ-ДД.', 400);
    from = a.day; to = a.day;
  } else if (hasRange) {
    if (!isYmd(a.from) || !isYmd(a.to)) throw new RpcError('Период указан неверно: нужны обе даты вида ГГГГ-ММ-ДД.', 400);
    if (a.from > a.to) throw new RpcError('Период указан неверно: начало позже конца.', 400);
    if (dayNum(a.to) - dayNum(a.from) + 1 > MAX_RANGE_DAYS) throw new RpcError('Период — не больше 7 дней.', 400);
    from = a.from; to = a.to;
  }
  let sources = null;
  if (!blank(a.sources)) {
    if (!Array.isArray(a.sources) || a.sources.some((s) => typeof s !== 'string' || !(SOURCE_KINDS.includes(s) || s === 'all'))) {
      throw new RpcError('Источник записи указан неверно.', 400);
    }
    sources = !a.sources.length || a.sources.includes('all') ? null : new Set(a.sources);
  }
  const status = blank(a.status) ? 'waiting' : a.status;
  if (typeof status !== 'string' || !(STATUS_KINDS.includes(status) || status === 'all')) {
    throw new RpcError('Статус записи указан неверно.', 400);
  }
  let doctorId = null;
  if (!blank(a.doctor_id)) {
    const n = typeof a.doctor_id === 'string' && /^\s*\d+\s*$/.test(a.doctor_id) ? Number(a.doctor_id) : a.doctor_id;
    if (!isPosInt(n)) throw new RpcError('Врач указан неверно.', 400);
    doctorId = n;
  }
  const q = searchArg(a.q);   // PageArgError — 400
  return { from, to, sources, status, doctorId, q };
}

/** Строки визитов периода без счёта: записи до прихода и направления врача (а, в). */
function lineRows(db, from, to, mine, only, explain = false) {
  const range = localRangeWhere('v.visit_date', from, to);
  return db.prepare(plan(explain) + `
    SELECT * FROM (
      SELECT vs.id AS vs_id, vs.visit_id, vs.service_id, vs.consultation_type_id, vs.doctor_id AS line_doctor_id,
             vs.created_by AS line_created_by, vs.created_at AS line_created_at,
             v.patient_id, v.status AS visit_status, v.booked_at, v.visit_date, v.created_by AS visit_created_by,
             v.doctor_id AS visit_doctor_id, v.sync_origin AS visit_origin,
             -- время — местное, тем же правилом SQLite, что и день (domain/day.js), а не часами Node
             CASE WHEN vs.scheduled_at IS NOT NULL AND vs.scheduled_at <> '' THEN strftime('%H:%M', vs.scheduled_at, 'localtime') END AS line_hhmm,
             strftime('%H:%M', v.visit_date, 'localtime') AS visit_hhmm,
             ${localDate('v.visit_date')} AS visit_day,
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

/** Записи календаря периода без единой живой строки (а′). */
function barBookingRows(db, from, to, mine, only, explain = false) {
  const range = localRangeWhere('v.visit_date', from, to);
  return db.prepare(plan(explain) + `
    SELECT v.id AS visit_id, v.patient_id, v.status AS visit_status, v.booked_at, v.visit_date,
           v.created_by AS visit_created_by, v.doctor_id AS visit_doctor_id, v.sync_origin AS visit_origin,
           strftime('%H:%M', v.visit_date, 'localtime') AS visit_hhmm, ${localDate('v.visit_date')} AS visit_day
      FROM visits v INDEXED BY idx_visits_date
     WHERE ${range.sql}
       AND v.status IN ('scheduled', 'confirmed') AND COALESCE(v.booked_at, '') <> ''
       AND ${BUILDING_SQL}
       AND NOT EXISTS (SELECT 1 FROM visit_services x WHERE x.visit_id = v.id AND x.status <> 'cancelled')
       ${only != null ? 'AND v.patient_id = ?' : ''}
     ORDER BY v.visit_date, v.id`).all(...range.params, ...buildingParams(mine), ...(only != null ? [only] : []));
}

/** Признаки визитов одним запросом: счёт, работа, отметка «оформлен», партнёр, запись CRM. */
function visitFacts(db, visitIds, explain = false, out = new Map()) {
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

/** Пациенты, у которых СВОЙ визит дня уже оформлен (для записей соседнего здания, ревью M5) — ключи «пациент|день». */
function ownRegistered(db, from, to, patientIds) {
  if (!patientIds.length) return new Set();
  const range = localRangeWhere('v.visit_date', from, to);
  return new Set(db.prepare(`
    SELECT DISTINCT v.patient_id, ${localDate('v.visit_date')} AS d FROM visits v
     WHERE ${IN_IDS('v.patient_id')} AND ${range.sql}
       AND v.sync_origin IS NULL AND COALESCE(v.status, '') NOT IN ('cancelled', 'no_show')
       AND (v.status NOT IN ('scheduled', 'confirmed')
            OR EXISTS (SELECT 1 FROM invoices ri WHERE ri.visit_id = v.id AND COALESCE(ri.status, '') <> 'void')
            OR EXISTS (SELECT 1 FROM visit_services rw WHERE rw.visit_id = v.id
                        AND (rw.status NOT IN ('added', 'cancelled', 'removed') OR rw.clinic_item_id IS NOT NULL))
            OR EXISTS (SELECT 1 FROM invoice_audit_log ra WHERE ra.visit_id = v.id AND ra.action = 'visit_registered'))`)
    .all(idList(patientIds), ...range.params).map((r) => Number(r.patient_id) + '|' + r.d));
}

/** Направления врача, которые регистратор не оформил с причиной (номер строки — миграция 287) → причина. */
function skippedLines(db, vsIds) {
  if (!vsIds.length) return new Map();
  try {
    return new Map(db.prepare(`SELECT visit_service_id AS id, reason FROM invoice_audit_log
                                WHERE ${IN_IDS('visit_service_id')} AND action = 'line_referral_skipped' ORDER BY id`)
      .all(idList(vsIds)).map((r) => [Number(r.id), r.reason || '']));
  } catch { return new Map(); }   // база до 287 — пропусков нет
}

// ─── CRM_BOOKINGS_TAB_V1: чтения статусов «Оформлены» / «Не пришли» / «Отменены» ───

/** Визиты периода (своё здание приёма) — кандидаты в «Оформлены» / «Не пришли» / «Отменены». */
function settledVisitRows(db, from, to, mine, only, explain = false) {
  const range = localRangeWhere('v.visit_date', from, to);
  return db.prepare(plan(explain) + `
    SELECT v.id AS visit_id, v.patient_id, v.status AS visit_status, v.booked_at, v.visit_date,
           v.created_by AS visit_created_by, v.doctor_id AS visit_doctor_id, v.sync_origin AS visit_origin,
           strftime('%H:%M', v.visit_date, 'localtime') AS visit_hhmm, ${localDate('v.visit_date')} AS visit_day
      FROM visits v INDEXED BY idx_visits_date
     WHERE ${range.sql}
       AND ${BUILDING_SQL}
       ${only != null ? 'AND v.patient_id = ?' : ''}
     ORDER BY v.visit_date, v.id`).all(...range.params, ...buildingParams(mine), ...(only != null ? [only] : []));
}

/** Строки услуг этих визитов (любой статус, кроме снятых; не товар) — тем же видом, что lineRows. */
function settledLineRows(db, visitIds, explain = false) {
  if (!visitIds.length && !explain) return [];
  return db.prepare(plan(explain) + `
    SELECT vs.id AS vs_id, vs.visit_id, vs.service_id, vs.consultation_type_id, vs.doctor_id AS line_doctor_id,
           vs.created_by AS line_created_by, vs.created_at AS line_created_at, vs.status AS line_status,
           v.patient_id, v.status AS visit_status, v.booked_at, v.visit_date, v.created_by AS visit_created_by,
           v.doctor_id AS visit_doctor_id, v.sync_origin AS visit_origin,
           CASE WHEN vs.scheduled_at IS NOT NULL AND vs.scheduled_at <> '' THEN strftime('%H:%M', vs.scheduled_at, 'localtime') END AS line_hhmm,
           strftime('%H:%M', v.visit_date, 'localtime') AS visit_hhmm,
           ${localDate('v.visit_date')} AS visit_day,
           CASE WHEN ${DOCTOR_ORDER_SQL} THEN 1 ELSE 0 END AS doctor_order,
           ${REFERRER_ID_SQL} AS referrer_id, lrs.name AS source_name,
           CASE WHEN ${NOT_REFUNDED_SQL} THEN 0 ELSE 1 END AS refunded
      FROM visit_services vs INDEXED BY idx_visit_services_visit
      JOIN visits v ON v.id = vs.visit_id
      LEFT JOIN users cu ON cu.id = vs.created_by
      LEFT JOIN referral_sources lrs ON lrs.id = vs.referred_by_source_id
     WHERE ${IN_IDS('vs.visit_id')}
       AND (v.sync_origin IS NOT NULL OR vs.sync_origin IS NULL)
       AND vs.clinic_item_id IS NULL
       AND (vs.service_id IS NOT NULL OR vs.consultation_type_id IS NOT NULL)
       AND COALESCE(vs.status, '') <> 'removed'
     ORDER BY v.visit_date, vs.id`).all(idList(visitIds));
}

/** Строки заявок CRM на дни периода, отменённые до визита (оператор убрал услугу). */
function crmCancelledRows(db, from, to, only, explain = false) {
  return db.prepare(plan(explain) + `
    SELECT l.id, l.request_id, l.service_id, l.consultation_type_id, l.doctor_id, date(l.scheduled_date) AS wish_day,
           r.patient_id, r.assigned_to, r.created_by AS card_created_by
      FROM crm_request_services l INDEXED BY idx_crm_req_services_date
      JOIN crm_requests r ON r.id = l.request_id
     WHERE l.scheduled_date >= date(?) AND l.scheduled_date < date(?, '+1 day')
       AND date(l.scheduled_date) BETWEEN date(?) AND date(?)
       AND l.status = 'cancelled' AND l.visit_id IS NULL AND r.patient_id IS NOT NULL
       ${only != null ? 'AND r.patient_id = ?' : ''}
     ORDER BY l.scheduled_date, l.id`).all(from, to, from, to, ...(only != null ? [only] : []));
}

/**
 * Анализы «на дату», отпущенные стойкой с причиной (crm_wish_release): строка журнала дня. С визитом
 * дня — по индексу визита среди визитов периода; без визита (отпущен до визита) — по тому же индексу
 * (visit_id IS NULL).
 */
function releasedRows(db, from, to, visitIds, { noVisit = false, explain = false } = {}) {
  const range = localRangeWhere('a.created_at', from, to);
  if (!noVisit && !visitIds.length && !explain) return [];
  return db.prepare(plan(explain) + `
    SELECT a.id, a.visit_id, a.reason, a.notes, a.actor_user_id, ${localDate('a.created_at')} AS rel_day
      FROM invoice_audit_log a INDEXED BY idx_invoice_audit_log_visit
     WHERE ${noVisit ? 'a.visit_id IS NULL' : IN_IDS('a.visit_id')}
       AND a.action = 'line_wish_released' AND ${range.sql}
     ORDER BY a.id`).all(...(noVisit ? [] : [idList(visitIds)]), ...range.params);
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
    lines: detail(lineRows(db, day, day, mine, null, true)),
    bare: detail(barBookingRows(db, day, day, mine, null, true)),
    facts: detail(visitFacts(db, visitIds, true)),
    wishes: detail(stepALinesForDay(db, day, { explain: true })),
  };
}

/**
 * CRM_BOOKINGS_TAB_V1 — планы чтений статусов (registrar-waiting-filters-plan.test.js).
 * @returns {{settled: string[], settledLines: string[], crmCancelled: string[], released: string[], releasedNoVisit: string[]}}
 */
export function crmBookingsQueryPlans(db, { visitIds = [1], from = null, to = null } = {}) {
  const day = today(db);
  const f = from || day;
  const t = to || day;
  const mine = selfLetter(db);
  const detail = (rows) => (rows || []).map((r) => String(r.detail));
  return {
    settled: detail(settledVisitRows(db, f, t, mine, null, true)),
    settledLines: detail(settledLineRows(db, visitIds, true)),
    crmCancelled: detail(crmCancelledRows(db, f, t, null, true)),
    released: detail(releasedRows(db, f, t, visitIds, { explain: true })),
    releasedNoVisit: detail(releasedRows(db, f, t, [], { noVisit: true, explain: true })),
  };
}

/** registrar_waiting({ patient_id?, count_only?, day? | from?+to?, sources?, status?, doctor_id?, q? }) → { today, from, to, status, count, rows?, doctors? } */
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
  const day0 = today(db);
  const f = parseFilter(a, day0);   // CRM_BOOKINGS_TAB_V1
  const { from, to } = f;
  const wants = new Set(f.status === 'all' ? STATUS_KINDS : [f.status]);
  const mine = selfLetter(db);
  // Статус того, что по правилу «ждёт» осталось неоформленным: сегодня и позже — ждёт; прошлый день — не пришёл.
  const pendingStatus = (d) => (String(d) < day0 ? 'no_show' : 'waiting');
  const needSettled = wants.has('registered') || wants.has('no_show') || wants.has('cancelled');

  // ── сбор: строки (а, в), записи без услуги (а′), анализы «на дату» (б) ──
  const lines = lineRows(db, from, to, mine, only);
  const bare = barBookingRows(db, from, to, mine, only);
  const wishes = [];
  for (const d of daysOf(from, to)) {
    for (const w of stepALinesForDay(db, d, { patientId: only })) { w.wish_day = d; wishes.push(w); }
  }
  const facts = visitFacts(db, [...lines.map((l) => l.visit_id), ...bare.map((b) => b.visit_id)]);
  const skipped = skippedLines(db, lines.filter((l) => Number(l.doctor_order) === 1).map((l) => l.vs_id));
  // CRM_BOOKINGS_TAB_V1 — визиты периода для статусов кроме «Ждут» (их признаки — тем же пакетом).
  const settled = needSettled ? settledVisitRows(db, from, to, mine, only) : [];
  // Признаки — только визитам, чей статус спрошен («Отменён» — для «Отменены», «Не пришёл» — для
  // «Не пришли», остальные — для «Оформлены»): «Отменены» не считает признаки всех визитов периода.
  const settledAsked = settled.filter((v) => (v.visit_status === 'cancelled' ? wants.has('cancelled')
    : v.visit_status === 'no_show' ? wants.has('no_show') : wants.has('registered')));
  if (settledAsked.length) visitFacts(db, settledAsked.map((v) => v.visit_id).filter((id) => !facts.has(Number(id))), false, facts);
  const foreignPatients = [...lines, ...bare, ...settledAsked].filter((x) => x.visit_origin != null).map((x) => x.patient_id);
  const ownDone = ownRegistered(db, from, to, foreignPatients);
  const doneOf = (x) => {
    const fx = facts.get(Number(x.visit_id));
    return !!(fx && fx.registered) || (x.visit_origin != null && ownDone.has(Number(x.patient_id) + '|' + x.visit_day));
  };

  // ── отбор: кто ещё ждёт (правило WAIT_REG_V1 — без изменений); что отбор отсеял — оформлено или отменено ──
  const keptLines = [];
  const doneLines = [];   // CRM_BOOKINGS_TAB_V1 — { line, status, reason }
  for (const l of lines) {
    if (Number(l.doctor_order) === 1) {
      if (skipped.has(Number(l.vs_id))) { doneLines.push({ l, status: 'cancelled', reason: skipped.get(Number(l.vs_id)) }); continue; }   // ревью M2 — не оформлено с причиной
      const at = (facts.get(Number(l.visit_id)) || {}).registeredAt;
      if (at && l.line_created_at && String(at) >= String(l.line_created_at)) { doneLines.push({ l, status: 'registered' }); continue; }   // оформлен без счёта после направления
      keptLines.push(l);
      continue;
    }
    if (PRE_ARRIVAL.includes(l.visit_status) && !doneOf(l)) keptLines.push(l);
    else doneLines.push({ l, status: 'registered' });
  }
  const keptBare = [];
  const doneBare = [];
  for (const b of bare) (doneOf(b) ? doneBare : keptBare).push(b);

  // ── CRM_BOOKINGS_TAB_V1: визиты периода — «Оформлены», «Не пришли», «Отменены» ──
  const itemized = new Set([...lines.map((l) => Number(l.vs_id))]);
  const visitsWithItems = new Set([...lines.map((l) => Number(l.visit_id)), ...bare.map((b) => Number(b.visit_id))]);
  const settledLines = [];   // { l, status }
  const settledBare = [];    // { b, status }
  if (settled.length) {
    const classOf = (v) => {
      if (v.visit_status === 'cancelled') return 'cancelled';
      if (v.visit_status === 'no_show') return 'no_show';
      if (!PRE_ARRIVAL.includes(v.visit_status) || doneOf(v)) return 'registered';
      return null;   // до прихода и не оформлен — правило «ждёт» выше
    };
    const picked = new Map();   // visit_id → { v, status }
    for (const v of settled) {
      const st = classOf(v);
      if (st && wants.has(st)) picked.set(Number(v.visit_id), { v, status: st });
    }
    const byVisit = new Map();
    for (const l of settledLineRows(db, [...picked.keys()])) {
      if (itemized.has(Number(l.vs_id))) continue;
      const p = picked.get(Number(l.visit_id));
      if (!p) continue;
      if (p.status === 'registered' && (l.line_status === 'cancelled' || Number(l.refunded) === 1)) continue;
      if (!byVisit.has(Number(l.visit_id))) byVisit.set(Number(l.visit_id), []);
      byVisit.get(Number(l.visit_id)).push(l);
    }
    for (const [vid, { v, status }] of picked) {
      const fx = facts.get(vid) || {};
      // Запись — время записи, связь с CRM или онлайн-запись партнёра; визит стойки «с улицы» — не запись:
      // из него в список идут только направления врача.
      const booked = String(v.booked_at || '').trim() !== '' || !!fx.crm || !!fx.partner;
      let own = byVisit.get(vid) || [];
      if (!booked) own = own.filter((l) => Number(l.doctor_order) === 1);
      for (const l of own) settledLines.push({ l, status });
      if (!own.length && booked && !visitsWithItems.has(vid)) settledBare.push({ b: v, status });
    }
  }

  // ── CRM_BOOKINGS_TAB_V1: «Отменены» — строки заявок и отпущенные стойкой анализы ──
  const cancelledWishes = [];   // строки заявок вида stepALinesForDay + wish_day, reason, name_override
  if (wants.has('cancelled')) {
    for (const w of crmCancelledRows(db, from, to, only)) cancelledWishes.push(w);
    const rel = [...releasedRows(db, from, to, settled.map((v) => v.visit_id)), ...releasedRows(db, from, to, [], { noVisit: true })];
    if (rel.length) {
      const parsed = rel.map((r) => ({ r, p: parseWishReleaseNotes(r.notes) })).filter((x) => x.p);
      const cards = new Map(parsed.length ? db.prepare(`SELECT id, patient_id, assigned_to, created_by FROM crm_requests WHERE ${IN_IDS('id')}`)
        .all(idList(parsed.map((x) => x.p.requestId))).map((c) => [Number(c.id), c]) : []);
      const visitPatient = new Map(settled.map((v) => [Number(v.visit_id), Number(v.patient_id)]));
      for (const { r, p } of parsed) {
        const card = cards.get(p.requestId) || null;
        const pid = r.visit_id != null && visitPatient.has(Number(r.visit_id)) ? visitPatient.get(Number(r.visit_id)) : (card ? Number(card.patient_id) : null);
        if (!pid || (only != null && pid !== only)) continue;
        cancelledWishes.push({ id: null, request_id: p.requestId, service_id: null, consultation_type_id: null, doctor_id: null,
          patient_id: pid, assigned_to: card ? card.assigned_to : null, card_created_by: card ? card.created_by : null,
          wish_day: r.rel_day, reason: r.reason || '', name_override: p.name, day_visit_id: r.visit_id ?? null });
      }
    }
  }

  // ── подписи: словари одним запросом на таблицу (count_only — только то, что решает фильтр) ──
  const users = new Map(db.prepare('SELECT id, username, full_name, role, extra_roles, is_doctor, is_active FROM users').all().map((u) => [Number(u.id), u]));
  // Ревью L6 — колл-центр и по «Дополнительным ролям».
  const isCallcenter = (uid) => {
    const u = uid != null ? users.get(Number(uid)) : null;
    return !!u && (u.role === 'callcenter' || parseRoles(u.extra_roles).includes('callcenter'));
  };
  const allWishes = [...wishes, ...cancelledWishes];
  const named = !countOnly;
  const svcIds = named ? [...lines, ...settledLines.map((x) => x.l), ...allWishes].map((x) => x.service_id).filter((v) => v != null) : [];
  const ctIds = named ? [...lines, ...settledLines.map((x) => x.l), ...allWishes].filter((x) => x.service_id == null).map((x) => x.consultation_type_id).filter((v) => v != null) : [];
  const services = new Map(svcIds.length ? db.prepare(`SELECT id, name FROM services WHERE ${IN_IDS('id')}`).all(idList(svcIds)).map((s) => [Number(s.id), s.name || '']) : []);
  const consults = new Map(ctIds.length ? db.prepare(`SELECT id, COALESCE(name_ru, name) AS name FROM consultation_types WHERE ${IN_IDS('id')}`).all(idList(ctIds)).map((s) => [Number(s.id), s.name || '']) : []);
  const reqIds = (named || f.sources) ? [...new Set(allWishes.map((w) => Number(w.request_id)))] : [];
  const partnerOfCard = new Map();
  if (reqIds.length) {
    try {
      for (const r of db.prepare(`SELECT ar.crm_request_id AS rid, ac.name FROM api_requests ar JOIN api_connections ac ON ac.id = ar.connection_id
                                   WHERE ${IN_IDS('ar.crm_request_id')} ORDER BY ar.id`).all(idList(reqIds))) {
        if (!partnerOfCard.has(Number(r.rid))) partnerOfCard.set(Number(r.rid), r.name || null);
      }
    } catch { /* база без подключений API — партнёров нет */ }
  }
  const lineName = (x) => (x.name_override != null ? x.name_override
    : (x.service_id != null ? services.get(Number(x.service_id)) : consults.get(Number(x.consultation_type_id)))) || '';

  const rows = new Map();   // «пациент|день|статус» → строка ответа
  const doctorIdsOf = new Map();   // та же строка → врачи строк (фильтр «Врач»)
  const rowOf = (pid, day, status) => {
    const id = Number(pid);
    const key = id + '|' + day + '|' + status;
    let r = rows.get(key);
    if (!r) {
      r = { patient_id: id, patient_name: '', mrn: '', phone: '', day, status,
        time: null, visit_id: null, visit_status: null, no_service: false, sources: [], doctors: [], services: [], booked_by: [], lines: [], reasons: [] };
      rows.set(key, r);
      doctorIdsOf.set(r, new Set());
    }
    return r;
  };
  const addUnique = (list, v) => { if (v && !list.includes(v)) list.push(v); };
  const addSource = (r, kind, name = '') => {
    if (!r.sources.some((s) => s.kind === kind && (s.name || '') === (name || ''))) r.sources.push({ kind, name: name || '' });
  };
  const earlier = (r, t) => { if (t && (!r.time || t < r.time)) r.time = t; };
  const addDoctor = (r, id) => { if (id != null && Number(id) > 0) doctorIdsOf.get(r).add(Number(id)); };
  const bookingSource = (x) => {
    const fx = facts.get(Number(x.visit_id)) || {};
    if (fx.partner) return ['partner', fx.partner];
    if (fx.crm || isCallcenter(x.visit_created_by) || isCallcenter(x.line_created_by)) return ['crm', ''];
    return ['calendar', ''];
  };
  // Время записи (booked_at — его ставил calendar_book); у визита дня без записи времени нет.
  const visitTime = (x) => (String(x.booked_at || '').trim() ? (x.visit_hhmm || null) : null);

  const addLine = (l, status, reason = null) => {
    const doctor = Number(l.doctor_order) === 1;
    const r = rowOf(l.patient_id, l.visit_day, status);
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
    addDoctor(r, lineDoctor);
    addUnique(r.booked_by, doctor ? nameOfUser(users.get(Number(l.line_created_by)))
      : (nameOfUser(users.get(Number(l.visit_created_by))) || nameOfUser(users.get(Number(l.line_created_by)))));
    addUnique(r.reasons, reason);
    r.lines.push({ kind: doctor ? 'doctor' : 'booked', visit_service_id: Number(l.vs_id), visit_id: Number(l.visit_id),
      service_id: l.service_id ?? null, consultation_type_id: l.service_id == null ? (l.consultation_type_id ?? null) : null,
      doctor_id: lineDoctor ?? null, name, doctor_name: doctorName, source, time,
      referrer_name: referrer, foreign: l.visit_origin != null });
  };

  const addBare = (b, status) => {
    const r = rowOf(b.patient_id, b.visit_day, status);
    if (r.visit_id == null) { r.visit_id = Number(b.visit_id); r.visit_status = b.visit_status; }
    const [source, partner] = bookingSource(b);
    addSource(r, source, partner);
    const time = visitTime(b);
    earlier(r, time);
    const doctorName = nameOfUser(users.get(Number(b.visit_doctor_id)));
    addUnique(r.doctors, doctorName);
    addDoctor(r, b.visit_doctor_id);
    addUnique(r.booked_by, nameOfUser(users.get(Number(b.visit_created_by))));
    r.lines.push({ kind: 'booking', visit_service_id: null, visit_id: Number(b.visit_id), service_id: null, consultation_type_id: null,
      doctor_id: b.visit_doctor_id ?? null, name: '', doctor_name: doctorName, source, time, referrer_name: '', foreign: b.visit_origin != null });
  };

  const addWish = (w, status) => {
    const r = rowOf(w.patient_id, w.wish_day, status);
    if (r.visit_id == null && w.day_visit_id != null) { r.visit_id = Number(w.day_visit_id); }
    const partner = partnerOfCard.get(Number(w.request_id)) || null;
    const source = partner ? 'partner' : 'crm';
    addSource(r, source, partner || '');
    const name = lineName(w);
    const doctorName = w.doctor_id != null ? nameOfUser(users.get(Number(w.doctor_id))) : '';
    addUnique(r.services, name);
    addUnique(r.doctors, doctorName);
    addDoctor(r, w.doctor_id);
    addUnique(r.booked_by, nameOfUser(users.get(Number(w.assigned_to != null ? w.assigned_to : w.card_created_by))));
    addUnique(r.reasons, w.reason || null);
    r.lines.push({ kind: 'wish', crm_line_id: w.id != null ? Number(w.id) : null, request_id: Number(w.request_id),
      service_id: w.service_id ?? null, consultation_type_id: w.service_id == null ? (w.consultation_type_id ?? null) : null,
      doctor_id: w.doctor_id ?? null, name, doctor_name: doctorName, source, time: null, referrer_name: '' });
  };

  // Порядок прежний: строки, записи без услуги, анализы «на дату»; затем — то, что не ждёт.
  for (const l of keptLines) { const st = pendingStatus(l.visit_day); if (wants.has(st)) addLine(l, st); }
  for (const b of keptBare) { const st = pendingStatus(b.visit_day); if (wants.has(st)) addBare(b, st); }
  for (const w of wishes) { const st = pendingStatus(w.wish_day); if (wants.has(st)) addWish(w, st); }
  for (const { l, status, reason } of doneLines) if (wants.has(status)) addLine(l, status, reason || null);
  for (const b of doneBare) if (wants.has('registered')) addBare(b, 'registered');
  for (const { l, status } of settledLines) addLine(l, status);
  for (const { b, status } of settledBare) addBare(b, status);
  for (const w of cancelledWishes) addWish(w, 'cancelled');

  // ── фильтры строки: источник (любой из), врач, поиск ──
  let out = [...rows.values()];
  if (f.sources) out = out.filter((r) => r.sources.some((s) => f.sources.has(s.kind)));
  if (f.doctorId != null) out = out.filter((r) => doctorIdsOf.get(r).has(f.doctorId));
  if (f.q && out.length) {
    const m = patientMatchSql(f.q);
    const hit = new Set(db.prepare(`SELECT pt.id FROM patients pt WHERE ${IN_IDS('pt.id')} AND ${m.sql}`)
      .all(idList(out.map((r) => r.patient_id)), ...m.params).map((p) => Number(p.id)));
    out = out.filter((r) => hit.has(r.patient_id));
  }

  if (countOnly) return { today: day0, from, to, status: f.status, count: out.length };

  const patients = new Map(out.length ? db.prepare(`SELECT id, full_name, mrn, phone FROM patients WHERE ${IN_IDS('id')}`).all(idList(out.map((r) => r.patient_id))).map((p) => [Number(p.id), p]) : []);
  // Пациент только с анализом «на дату» и визитом дня — статус этого визита (одним запросом).
  const statusOf = out.filter((r) => r.visit_status == null && r.visit_id != null).map((r) => r.visit_id);
  const visitStatus = new Map(statusOf.length ? db.prepare(`SELECT id, status FROM visits WHERE ${IN_IDS('id')}`).all(idList(statusOf)).map((v) => [Number(v.id), v.status]) : []);
  for (const r of out) {
    const p = patients.get(r.patient_id) || {};
    r.patient_name = p.full_name || ''; r.mrn = p.mrn || ''; r.phone = p.phone || '';
    r.no_service = r.lines.length > 0 && r.lines.every((l) => l.kind === 'booking');
    if (r.visit_status == null && r.visit_id != null) r.visit_status = visitStatus.get(Number(r.visit_id)) ?? null;
  }
  const byName = new Intl.Collator('ru');   // ревью M6 — один сборщик на сортировку, а не localeCompare(…, 'ru') на каждое сравнение
  out.sort((x, y) => {
    if (x.day !== y.day) return x.day < y.day ? -1 : 1;   // CRM_BOOKINGS_TAB_V1 — по дню
    if (x.time && y.time && x.time !== y.time) return x.time < y.time ? -1 : 1;
    if (!!x.time !== !!y.time) return x.time ? -1 : 1;
    return (STATUS_ORDER[x.status] - STATUS_ORDER[y.status])
      || byName.compare(String(x.patient_name), String(y.patient_name)) || x.patient_id - y.patient_id;
  });
  // Врачи фильтра — те, кого сервер считает врачами (is_doctor или роль «Врач»), действующие; выбранный — всегда.
  const doctors = [...users.values()]
    .filter((u) => ((Number(u.is_doctor) === 1 || u.role === 'doctor') && Number(u.is_active ?? 1) === 1) || Number(u.id) === f.doctorId)
    .map((u) => ({ id: Number(u.id), name: nameOfUser(u) }))
    .sort((x, y) => byName.compare(x.name, y.name) || x.id - y.id);
  return { today: day0, from, to, status: f.status, count: out.length, rows: out, doctors };
}
