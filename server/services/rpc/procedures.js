// PROC_PERFORMER_V1 — очередь процедур: сервер.
//
// Владелец, дословно: «procedures, either can be for doctors or nurses, or
// either can be for the procedure room ambulator patients or can be for
// stationary patients. and they too should come to the employee. as a selected
// service provider when setting a service and the registator selects the
// provider.»
//
// Три требования, и каждое здесь названо своим кодом:
//   1. исполнитель — врач ИЛИ медсестра        → canPerformProcedures + assign;
//   2. процедура бывает амбулаторная (процедурный кабинет) и палатная
//      (стационар)                             → две половины proceduresList;
//   3. назначенная процедура приходит ИМЕННО тому, кого выбрали
//                                              → scopeOf + фильтр исполнителя.
//
// ─── ПОЧЕМУ ЭТО СЕРВЕР, А НЕ ЕЩЁ ОДИН ЗАПРОС ИЗ БРАУЗЕРА ───────────────────
//
// Экран процедур собирал очередь сам, одним запросом к visit_services, и
// поэтому палатной процедуры не видел ВООБЩЕ: она живёт в другой таблице
// (admission_services), доступной только через госпитализацию. Склеить две
// таблицы, отсортировать по времени и отрезать 300 строк можно ровно в одном
// месте — там, где есть SQL. Заодно правило «кому это видно» перестаёт быть
// украшением браузера: медсестра, попросившая чужую очередь curl'ом с любого
// компьютера клиники, получает свою.
//
// ─── ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ ─────────────────────────────────────────────
//
// Своего понятия «процедура». Оно одно на систему и живёт в маршрутизации
// услуг (SERVICE_GROUP_ROUTING_V1): услуга процедурная, когда её отделение
// departments.kind = 'procedure' ИЛИ её тип services.type = 'procedure'. Здесь
// это выражение написано ОДИН раз (PROCEDURE_SERVICE_SQL) и подставляется в
// обе половины.
//
// Своей арифметики денег. Ни один путь этого файла не пишет unit_price, total,
// invoice_item_id и admission_services.doctor_id. Почему последнее — в шапке
// миграции 102: doctor_id палатной строки это ЛЕЧАЩИЙ врач, по нему
// rpc/billing.js берёт личную цену в счёт пациента, и подменить его медсестрой
// значит уронить сумму счёта.

import { hasAnyRole } from '../roles.js';
import { hasColumn } from '../domain/buildings.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Читают очередь все, кто около неё работает. Регистратура — потому что именно
// она ставит услугу и выбирает исполнителя, и обязана видеть, что процедура
// доехала.
const READ_ROLES   = ['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse', 'registrar'];
const ASSIGN_ROLES = ['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse', 'registrar'];
const DONE_ROLES   = ['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];

// Роли, которым процедуру ВООБЩЕ можно поручить. Врач сюда попадает НЕ отсюда,
// а по is_doctor — см. canPerformProcedures.
const PERFORMER_ROLES = ['nurse', 'senior_nurse', 'doctor', 'head_doctor'];

// Статусы строки визита, которые очередь показывает. 'added' («Назначено»)
// показывается намеренно: пациент направлен, но касса ещё не провела — экран
// подписывает это «Ожидает кассу» и провести не даёт (#15).
const OPEN_STATUSES = ['added', 'queued', 'in_progress', 'completed'];

// SERVICE_GROUP_ROUTING_V1 — что считается процедурой. Одно выражение на оба
// запроса: разойдясь, они дали бы медсестре очередь, отличную от очереди
// администратора, на одних и тех же данных.
const PROCEDURE_SERVICE_SQL = "(s.type = 'procedure' OR d.kind = 'procedure')";

function parseRoles(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter((r) => typeof r === 'string') : []; }
  catch { return []; }
}

/**
 * Может ли этот СОТРУДНИК (строка users, не сессия) быть исполнителем.
 *
 * ADMIN_DOCTOR_LIST_V1 — инвариант всей системы: «врач» проверяется по
 * is_doctor, а НЕ по role. Администратор клиники сплошь и рядом ведёт приём;
 * у него role = 'admin', specialty пустая, и проверка по роли выкинула бы его
 * из списка врачей — ровно та ошибка, которую однажды уже чинили в шести
 * фильтрах SPA. Роль здесь спрашивается только у тех, у кого своего флага нет:
 * у медсестры.
 */
export function canPerformProcedures(u) {
  if (!u) return false;
  if (u.is_doctor) return true;                 // ← инвариант: флаг, а не роль
  const extra = parseRoles(u.extra_roles);
  return [u.role, ...extra].some((r) => PERFORMER_ROLES.includes(r));
}

/**
 * SERVICE_SCOPE_V1 — «своё» против «всё». Правило то же, что у «Моих услуг» и
 * что у браузерного scopedProviderId(): полный администратор видит клинику
 * целиком, остальные — назначенное ИМ плюс ничьё (свободную процедуру у
 * процедурного кабинета берёт тот, кто её делает; ждать администратора там
 * некому).
 */
export function scopeOf(user) {
  return hasAnyRole(user, ['admin']) ? 'all' : 'own';
}

function requireRole(user, allowed, what) {
  if (!hasAnyRole(user, allowed)) throw new RpcError(what + ' — недоступно вашей роли.', 403);
}

function isPositiveInt(v) { return Number.isInteger(v) && v > 0; }

function patientName(r) {
  const composed = [r.last_name, r.first_name].filter(Boolean).join(' ').trim();
  return composed || r.full_name || '';
}

// BRANCH_ORIGIN_V1 — «очередь и кабинет врача — своего здания» (решение
// владельца 2026-09-02). Чужая строка приезжает без врача и без цены и встала
// бы в очередь медсестры пустой строкой. Колонка спрашивается у базы, а не
// предполагается: на установке до миграции 083 её нет, и запрос упал бы вместо
// того, чтобы вернуть всё своё. У таблиц стационара её нет и не будет —
// госпитализации между зданиями не ездят вовсе (шапка 091), поэтому палатная
// половина своя по устройству, а не по фильтру.
function ownBuildingOnly(db, table, alias) {
  return hasColumn(db, table, 'sync_origin') ? ' AND ' + alias + '.sync_origin IS NULL' : '';
}

/**
 * Очередь процедур: амбулаторные (процедурный кабинет) + палатные (стационар).
 *
 * Возвращает { scope, me, rows }. `scope` — 'all' у администратора, 'own' у
 * всех остальных; экран подписывает им пустое состояние, чтобы медсестра не
 * гадала, пусто ли в клинике или пусто у неё.
 */
export function proceduresList(db, args, user) {
  requireRole(user, READ_ROLES, 'Очередь процедур');
  const scope = scopeOf(user);
  const me = (user && user.id) || null;
  const limit = Math.min(500, Math.max(1, Number((args && args.limit) || 300)));

  // ── половина 1: АМБУЛАТОРНАЯ. Строка визита; исполнитель = doctor_id
  // (эта колонка на visit_services и есть исполнитель — см. миграцию 102).
  const outSql = `
    SELECT vs.id, vs.status, vs.notes, vs.created_at, vs.doctor_id AS performer_id,
           vs.verified_at, vs.verified_by, vs.invoice_item_id,
           s.name AS service,
           u.full_name AS performer, u.role AS performer_role, u.is_doctor AS performer_is_doctor,
           vb.full_name AS done_by,
           v.id AS visit_id, v.visit_date, v.patient_id,
           p.full_name, p.last_name, p.first_name, p.phone, p.mrn, p.date_of_birth, p.gender
      FROM visit_services vs
      JOIN visits   v ON v.id = vs.visit_id
      LEFT JOIN patients p ON p.id = v.patient_id
      LEFT JOIN services s ON s.id = vs.service_id
      LEFT JOIN departments d ON d.id = s.department_id
      LEFT JOIN users u  ON u.id  = vs.doctor_id
      LEFT JOIN users vb ON vb.id = vs.verified_by
     WHERE ${PROCEDURE_SERVICE_SQL}
       AND vs.clinic_item_id IS NULL
       AND vs.status IN (${OPEN_STATUSES.map(() => '?').join(',')})
       ${ownBuildingOnly(db, 'visit_services', 'vs')}
     ORDER BY vs.created_at DESC
     LIMIT ?`;
  const outRows = db.prepare(outSql).all(...OPEN_STATUSES, limit).map((r) => ({
    kind: 'outpatient',
    id: r.id,
    status: r.status,
    service: r.service || '',
    patient: patientName(r),
    phone: r.phone || '',
    mrn: r.mrn || '',
    dob: r.date_of_birth || null,
    sex: r.gender || null,
    performer_id: r.performer_id == null ? null : r.performer_id,
    performer: r.performer || '',
    performer_role: r.performer_role || '',
    performer_is_doctor: !!r.performer_is_doctor,
    unassigned: r.performer_id == null,
    done: r.status === 'completed',
    done_at: r.verified_at || null,
    done_by: r.done_by || '',
    notes: r.notes || '',
    when: r.visit_date || r.created_at,
    visit_id: r.visit_id == null ? null : r.visit_id,
    patient_id: r.patient_id == null ? null : r.patient_id,
    admission_id: null,
    ward: '',
    bed: '',
  }));

  // ── половина 2: ПАЛАТНАЯ. Строка госпитализации; исполнитель = performer_id
  // (миграция 102), doctor_id НЕ ЧИТАЕТСЯ вовсе — это лечащий и деньги.
  //
  // «Выполнено» здесь — это performed_at, а НЕ status. Статус палатной строки
  // принадлежит счёту: 'completed' ставит касса, когда строка попадает в счёт
  // (billing.js createInvoiceForAdmission), и сводка «Отчёты» складывает
  // выручку стационара именно по completed. Отметить процедуру статусом значило
  // бы объявить выручку в момент укола. performed_at пуст у всех строк,
  // заведённых койкой, и заполняется ровно тем, кто нажал «Выполнить».
  const inSql = `
    SELECT asv.id, asv.status, asv.notes, asv.created_at, asv.performed_at,
           asv.performer_id, asv.billable, asv.invoice_item_id,
           s.name AS service,
           u.full_name AS performer, u.role AS performer_role, u.is_doctor AS performer_is_doctor,
           a.id AS admission_id, a.patient_id, a.admitted_at, a.status AS admission_status,
           COALESCE(w.name, aw.name) AS ward, COALESCE(b.code, ab.code) AS bed,
           p.full_name, p.last_name, p.first_name, p.phone, p.mrn, p.date_of_birth, p.gender
      FROM admission_services asv
      JOIN admissions a ON a.id = asv.admission_id
      LEFT JOIN patients p ON p.id = a.patient_id
      LEFT JOIN services s ON s.id = asv.service_id
      LEFT JOIN departments d ON d.id = s.department_id
      LEFT JOIN users u ON u.id = asv.performer_id
      LEFT JOIN wards w  ON w.id  = asv.ward_id
      LEFT JOIN wards aw ON aw.id = a.ward_id
      LEFT JOIN beds  b  ON b.id  = asv.bed_id
      LEFT JOIN beds  ab ON ab.id = a.bed_id
     WHERE ${PROCEDURE_SERVICE_SQL}
       AND asv.clinic_item_id IS NULL
       AND a.status NOT IN ('discharged', 'cancelled')
       ${ownBuildingOnly(db, 'admission_services', 'asv')}
     ORDER BY asv.created_at DESC
     LIMIT ?`;
  const inRows = db.prepare(inSql).all(limit).map((r) => ({
    kind: 'inpatient',
    id: r.id,
    // Экран показывает ОДИН словарь состояний на оба вида. У палатной строки
    // «сделано» = performed_at; всё остальное — «в работе», потому что кассовый
    // статус ('added'/'completed') отвечает на другой вопрос.
    status: r.performed_at ? 'completed' : 'in_progress',
    service: r.service || '',
    patient: patientName(r),
    phone: r.phone || '',
    mrn: r.mrn || '',
    dob: r.date_of_birth || null,
    sex: r.gender || null,
    performer_id: r.performer_id == null ? null : r.performer_id,
    performer: r.performer || '',
    performer_role: r.performer_role || '',
    performer_is_doctor: !!r.performer_is_doctor,
    unassigned: r.performer_id == null,
    done: !!r.performed_at,
    done_at: r.performed_at || null,
    done_by: r.performed_at ? (r.performer || '') : '',
    notes: r.notes || '',
    when: r.created_at || r.admitted_at,
    visit_id: null,
    patient_id: r.patient_id == null ? null : r.patient_id,
    admission_id: r.admission_id == null ? null : r.admission_id,
    ward: r.ward || '',
    bed: r.bed || '',
  }));

  const rows = [...outRows, ...inRows]
    // Правило видимости — ОДНО на обе половины: администратор видит всё,
    // остальные — своё и ничьё.
    .filter((r) => scope === 'all' || r.performer_id == null || r.performer_id === me)
    .sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')))
    .slice(0, limit);

  return { scope, me, rows };
}

// Обе половины адресуются одинаково: {kind, id}. Одна таблица на вид.
function tableFor(kind) {
  if (kind === 'outpatient') return { table: 'visit_services', col: 'doctor_id' };
  if (kind === 'inpatient')  return { table: 'admission_services', col: 'performer_id' };
  throw new RpcError('Неизвестный вид процедуры.', 400);
}

function loadLine(db, kind, id) {
  const { table } = tableFor(kind);
  const row = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(id);
  if (!row) throw new RpcError('Процедура не найдена.', 400);
  return row;
}

/**
 * Назначить исполнителя процедуры (кнопка «Взять» и выбор регистратуры).
 *
 * performer_id не передан — исполнителем становится тот, кто позвал.
 */
export function procedureAssign(db, args, user) {
  requireRole(user, ASSIGN_ROLES, 'Назначение исполнителя');
  const kind = args && args.kind;
  const id = args && args.id;
  if (!isPositiveInt(id)) throw new RpcError('Некорректная строка процедуры.', 400);
  const { table, col } = tableFor(kind);

  const performerId = (args && args.performer_id != null) ? args.performer_id : (user && user.id);
  if (!isPositiveInt(performerId)) throw new RpcError('Не удалось определить исполнителя.', 400);

  const staff = db.prepare(
    'SELECT id, full_name, role, extra_roles, is_doctor, is_active FROM users WHERE id = ?',
  ).get(performerId);
  if (!staff) throw new RpcError('Сотрудник не найден.', 400);
  if (staff.is_active === 0) throw new RpcError('Сотрудник неактивен.', 400);
  // Требование владельца целиком: «either can be for doctors or nurses» — и
  // ТОЛЬКО они. Касса, склад и регистратура процедуру не делают и молча
  // оказаться исполнителем не должны.
  if (!canPerformProcedures(staff)) {
    throw new RpcError('Исполнителем процедуры может быть врач или медсестра.', 400);
  }

  const line = loadLine(db, kind, id);

  // DOCTOR_OWN_PRICE_V1 — почему чужого исполнителя нельзя перебить мимоходом.
  //
  // У амбулаторной строки исполнитель И ЕСТЬ doctor_id, а по doctor_id
  // rpc/billing.js берёт ЛИЧНУЮ ЦЕНУ исполнителя в счёт (unitPriceFor). Пока
  // счёт не выставлен, смена исполнителя МЕНЯЕТ будущую сумму. Взять свободную
  // процедуру может кто угодно из смены, а переназначить занятую — только тот,
  // кто за это отвечает: администратор и регистратура.
  if (kind === 'outpatient'
      && line[col] != null
      && line[col] !== performerId
      && line.invoice_item_id == null
      && !hasAnyRole(user, ['admin', 'registrar'])) {
    throw new RpcError('Процедура уже назначена другому исполнителю — переназначить может администратор или регистратура.', 403);
  }

  db.prepare('UPDATE ' + table + ' SET ' + col + ' = ? WHERE id = ?').run(performerId, id);
  return { kind, id, performer_id: performerId, performer: staff.full_name || '' };
}

/**
 * Отметить процедуру выполненной.
 *
 * Амбулаторная — как и раньше: status='completed' + verified_at/verified_by
 * (штамп «кто нажал»), и незанятая строка заодно закрепляется за тем, кто её
 * провёл. Палатная — ТОЛЬКО performed_at + исполнитель: её status принадлежит
 * счёту, а не медсестре (см. комментарий в proceduresList).
 */
export function procedureComplete(db, args, user) {
  requireRole(user, DONE_ROLES, 'Отметка о выполнении');
  const kind = args && args.kind;
  const id = args && args.id;
  if (!isPositiveInt(id)) throw new RpcError('Некорректная строка процедуры.', 400);
  const notes = (args && typeof args.notes === 'string') ? args.notes.trim() : '';
  const me = (user && user.id) || null;
  const line = loadLine(db, kind, id);

  if (kind === 'outpatient') {
    // #15 — pay-first: касса ещё не провела услугу, делать её нельзя.
    if (line.status === 'added') {
      throw new RpcError('Услуга не проведена кассой — сначала оплата или долг.', 400);
    }
    db.prepare(`UPDATE visit_services
                   SET status = 'completed',
                       notes = ?,
                       verified_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                       verified_by = ?,
                       doctor_id = COALESCE(doctor_id, ?)
                 WHERE id = ?`).run(notes || null, me, me, id);
  } else {
    db.prepare(`UPDATE admission_services
                   SET performed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                       notes = ?,
                       performer_id = COALESCE(performer_id, ?)
                 WHERE id = ?`).run(notes || null, me, id);
  }
  return { kind, id, done: true };
}
