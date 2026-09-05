// CALENDAR_BOOKING_V1 — запись на приём: что свободно и кто куда записан.
//
// Два обработчика:
//   calendar_slots  — ЧИТАЕТ: свободные начала приёма у врача (или в кабинете)
//                     на день, с учётом графика, обеда, часов клиники и уже
//                     занятого. Стоит в READ_ONLY_RPCS (control/gate.js).
//   calendar_book   — ПИШЕТ: создаёт запись, а с visit_id — переносит или
//                     растягивает существующую. ОДИН вход на все три действия,
//                     потому что проверка у всех трёх одна и та же.
//
// ─── ЗАПРЕТ ДВОЙНОЙ ЗАПИСИ ──────────────────────────────────────────────────
//
// Правило владельца (2026-09-05): «Один пациент на врача на слот — жёсткий
// запрет». Жёсткий — значит на сервере: проверка, которую можно обойти,
// выключив JavaScript или послав тот же запрос curl'ом из соседнего кабинета,
// запретом не является.
//
// Отказ НАЗЫВАЕТ ЗАНЯТОЕ ВРЕМЯ, а не говорит «нельзя». Регистратура работает с
// человеком у стойки: «занято» без времени заставляет её тыкать в сетку
// наугад, «занято 14:30–15:00» — сразу предложить 15:00.
//
// ЭКСТРЕННАЯ ЗАПИСЬ — ОТДЕЛЬНОЕ ДЕЙСТВИЕ С ПРИЧИНОЙ, а не тихий обход.
// Поверх занятого времени записать можно, но только назвав, зачем; причина
// уходит в visits.notes, то есть остаётся в самой записи и уезжает филиалам
// вместе с ней (notes — в SHIPPED). Флаг без причины отвергается: «галочка,
// снимающая проверку» — это отсутствие проверки.
//
// ─── ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ ────────────────────────────────────────────────
//
// 1. Запрета на двойную занятость КАБИНЕТА. Правило владельца сформулировано
//    про врача, и только про врача. У кабинета есть capacity (миграция 082), в
//    процедурной одновременно бывает несколько человек, и запрет там означал бы
//    запрет того, что клиника делает каждый день. Ось кабинетов остаётся
//    показывающей, а не запрещающей.
// 2. Ограничения в самой базе. Разбор — в шапке миграции 099: ensure_visit
//    ставит визит-контейнер дня на 09:00, и ограничение уровня таблицы
//    отказало бы второму пациенту врача в регистрации вовсе. Именно так и
//    случилось в старшей системе (visits_no_overlap).
// 3. Проверки чужого здания. doctor_id между зданиями НЕ ЕЗДИТ (SHIPPED.visits
//    его не везёт: локальный id указывал бы в пустоту), поэтому у приехавшей
//    записи doctor_id локально NULL и в занятость врача она попасть не может
//    физически. Межфилиальный календарь — следующая задача, и она начинается
//    именно с этого: повезти врача ссылкой по username.

import { hasAnyRole } from '../roles.js';
import {
  BUSY_STATUSES, DEFAULT_DURATION_MIN,
  clampWindow, clinicWindow, dayWindow, formatHhmm,
  overlapsMs, serviceDurationMinutes, slotStarts, windowSegments,
} from './slot-engine.js';

export class RpcError extends Error {
  constructor(msg, status = 400, code = null, params = null) {
    super(msg);
    this.status = status;
    if (code) this.code = code;
    if (params) this.params = params;
  }
}

// Кто записывает. Ровно те же роли, что уже могут вставлять и править visits
// через /api/db (schema-registry): RPC не должен быть ни щедрее, ни строже
// таблицы, иначе «через календарь нельзя, а через список можно».
const BOOK_ROLES = ['admin', 'registrar', 'doctor'];

function requireRole(user, allowed) {
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError('Your role is not allowed to perform this action.', 403);
  }
}

const isPosInt = (v) => Number.isInteger(v) && v > 0;

function optId(v, name) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!isPosInt(n)) throw new RpcError(name + ' must be a positive integer.', 400);
  return n;
}

// ─── ВРЕМЯ ──────────────────────────────────────────────────────────────────
//
// Единственное место во всём календаре, где существует часовой пояс. Сервер
// стоит в той же клинике, что и регистратура (easymed.local — коробка в
// здании), поэтому местное время процесса и есть местное время клиники, а
// график врача («09:00») — местное настенное время.
//
// Внутрь движка слотов уходят МИНУТЫ ДНЯ, наружу в базу — ISO в UTC.

/** 'YYYY-MM-DD' → Date локальной полуночи этого дня. Бросает на мусоре. */
function localMidnight(dayIso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayIso || '').trim());
  if (!m) throw new RpcError('date must be YYYY-MM-DD.', 400);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  if (Number.isNaN(d.getTime())) throw new RpcError('date must be YYYY-MM-DD.', 400);
  return d;
}

/** Момент времени → минуты от местной полуночи. */
const minutesOfLocal = (ms) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };

/** Момент времени → 'YYYY-MM-DD' местного дня. */
function localDayIso(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Начало приёма из аргументов. Принимаются обе формы, потому что обе уже
 * ходят по этому коду:
 *   '2026-09-05T09:30:00.000Z' — абсолютное (Date#toISOString у клиента);
 *   '2026-09-05T09:30'         — местное настенное (input type=time + date).
 * Пустая строка и мусор — отказ, а не «сегодня в 00:00».
 */
function parseStart(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) throw new RpcError('start is required (ISO datetime).', 400);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new RpcError('start must be an ISO datetime.', 400);
  return ms;
}

// ─── ЗАНЯТОСТЬ ──────────────────────────────────────────────────────────────

/**
 * Приёмы врача (или кабинета), пересекающие сутки вокруг дня. Границы берутся
 * с запасом в сутки, а точное попадание считается в АБСОЛЮТНЫХ миллисекундах:
 * сравнивать ISO-строки на границе суток — значит зависеть от того, написал
 * автор строки '…:00Z' или '…:00.000Z' (в базе есть обе формы: ensure_visit
 * пишет первую, мастер визита — вторую).
 *
 * Занято = статусы scheduled/confirmed/arrived. Отменённый и не пришедший
 * время НЕ занимают — иначе отменённая запись держала бы слот навсегда.
 */
function loadBusy(db, { doctorId, roomId, fromMs, toMs, excludeVisitId }) {
  const col = doctorId ? 'doctor_id' : 'room_id';
  const id = doctorId || roomId;
  if (!id) return [];
  const pad = 24 * 3600 * 1000;
  const rows = db.prepare(`
    SELECT v.id, v.visit_date, v.duration_minutes, v.status, v.patient_id, v.service_id,
           p.full_name AS patient_name
      FROM visits v
      LEFT JOIN patients p ON p.id = v.patient_id
     WHERE v.${col} = ?
       AND v.status IN (${BUSY_STATUSES.map(() => '?').join(',')})
       AND v.visit_date >= ? AND v.visit_date < ?
     ORDER BY v.visit_date
  `).all(id, ...BUSY_STATUSES, new Date(fromMs - pad).toISOString(), new Date(toMs + pad).toISOString());

  const out = [];
  for (const r of rows) {
    if (excludeVisitId && r.id === excludeVisitId) continue;   // переносим саму себя — она себе не мешает
    const startMs = Date.parse(r.visit_date);
    if (Number.isNaN(startMs)) continue;
    const dur = Math.max(1, Number(r.duration_minutes) || DEFAULT_DURATION_MIN);
    const endMs = startMs + dur * 60000;
    if (endMs <= fromMs || startMs >= toMs) continue;
    out.push({
      visit_id: r.id, startMs, endMs, durationMin: dur,
      status: r.status, patient_id: r.patient_id, patient_name: r.patient_name || '',
    });
  }
  return out;
}

/** Длительность записи: из услуги, иначе явная, иначе 15 (решение владельца). */
function resolveDuration(db, { serviceId, explicit }) {
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const n = Math.round(Number(explicit));
    if (!Number.isFinite(n) || n < 5) throw new RpcError('duration_minutes must be at least 5.', 400);
    if (n > 24 * 60) throw new RpcError('duration_minutes must be under 24 hours.', 400);
    return n;
  }
  if (serviceId) {
    const svc = db.prepare('SELECT duration_minutes FROM services WHERE id = ?').get(serviceId);
    return serviceDurationMinutes(svc, DEFAULT_DURATION_MIN);
  }
  return DEFAULT_DURATION_MIN;
}

/** Окно ресурса на день, уже суженное часами клиники. */
function resourceWindow(db, { doctor, room, dayIso }) {
  const weekday = localMidnight(dayIso).getDay();
  const res = doctor || room;
  if (!res) return null;
  const win = dayWindow(res.working_hours, weekday);
  // WORKING_HOURS_CLINIC_BOUND_V1 — здание бьёт по графику ресурса: врач,
  // работающий до 20:00 в клинике, закрывающейся в 18:00, принимает до 18:00.
  const branchId = doctor ? doctor.branch_id : null;
  const branch = branchId
    ? db.prepare('SELECT id, working_hours, is_24_7 FROM branches WHERE id = ?').get(branchId)
    : null;
  return clampWindow(win, clinicWindow(branch, weekday));
}

// ═══════════════════════════════════════════════════════════════════════════
// calendar_slots — что свободно
// ═══════════════════════════════════════════════════════════════════════════

/**
 * args: { doctor_id? , room_id?, date:'YYYY-MM-DD', service_id?,
 *         duration_minutes?, step_minutes?, exclude_visit_id? }
 *
 * Возвращает окно дня, свободные начала и занятое — всё в местном настенном
 * времени ('09:30') плюс ISO для тех, кто будет записывать.
 */
export function calendarSlots(db, args, user) {
  requireRole(user, BOOK_ROLES);
  const a = args || {};
  const doctorId = optId(a.doctor_id, 'doctor_id');
  const roomId = optId(a.room_id, 'room_id');
  if (!doctorId && !roomId) throw new RpcError('doctor_id or room_id is required.', 400);
  if (doctorId && roomId) throw new RpcError('pass doctor_id or room_id, not both.', 400);

  const dayIso = String(a.date || '').slice(0, 10);
  const midnight = localMidnight(dayIso);
  const dayStartMs = midnight.getTime();
  const dayEndMs = dayStartMs + 24 * 3600 * 1000;

  const doctor = doctorId
    ? db.prepare('SELECT id, full_name, working_hours, branch_id, scheduling_mode FROM users WHERE id = ?').get(doctorId)
    : null;
  if (doctorId && !doctor) throw new RpcError('doctor not found.', 400);
  const room = roomId
    ? db.prepare('SELECT id, name, code, working_hours FROM rooms WHERE id = ?').get(roomId)
    : null;
  if (roomId && !room) throw new RpcError('room not found.', 400);

  const serviceId = optId(a.service_id, 'service_id');
  const durationMin = resolveDuration(db, { serviceId, explicit: a.duration_minutes });
  const stepMin = a.step_minutes ? Math.max(5, Math.round(Number(a.step_minutes))) : durationMin;
  const excludeVisitId = optId(a.exclude_visit_id, 'exclude_visit_id');

  const win = resourceWindow(db, { doctor, room, dayIso });
  const busy = loadBusy(db, { doctorId, roomId, fromMs: dayStartMs, toMs: dayEndMs, excludeVisitId });

  // Занятое переводится в минуты дня СМЕЩЕНИЕМ ОТ ПОЛУНОЧИ, а не часами начала:
  // приём, начавшийся вчера в 23:40 и кончающийся сегодня в 00:10, обязан
  // занять первые десять минут суток, а не 1420-ю минуту.
  const clampMin = (ms) => Math.max(0, Math.min(24 * 60, Math.round((ms - dayStartMs) / 60000)));
  const busyMinutes = busy.map((b) => ({ from: clampMin(b.startMs), to: clampMin(b.endMs) }))
    .filter((b) => b.to > b.from);

  // «Сейчас» отсекает прошедшие слоты только СЕГОДНЯ: вчерашний день читают,
  // чтобы посмотреть, что было, а не чтобы записать.
  const now = Date.now();
  const minStartMin = (now >= dayStartMs && now < dayEndMs) ? minutesOfLocal(now) : null;

  const segments = windowSegments(win);
  const starts = slotStarts({ segments, busy: busyMinutes, durationMin, stepMin, minStartMin });

  return {
    date: dayIso,
    resource: doctor
      ? { kind: 'doctor', id: doctor.id, name: doctor.full_name || '', scheduling_mode: doctor.scheduling_mode || '' }
      : { kind: 'room', id: room.id, name: room.name || '', code: room.code || '' },
    duration_minutes: durationMin,
    step_minutes: stepMin,
    window: win ? { from: formatHhmm(win.from), to: formatHhmm(win.to), breaks: (win.breaks || []).map((b) => ({ from: formatHhmm(b.from), to: formatHhmm(b.to) })) } : null,
    slots: starts.map((t) => ({
      start: formatHhmm(t),
      end: formatHhmm(t + durationMin),
      start_iso: new Date(dayStartMs + t * 60000).toISOString(),
    })),
    busy: busy.map((b) => ({
      visit_id: b.visit_id,
      from: formatHhmm(minutesOfLocal(b.startMs)),
      to: formatHhmm(minutesOfLocal(b.startMs) + b.durationMin),
      duration_minutes: b.durationMin,
      status: b.status,
      patient_id: b.patient_id,
      patient_name: b.patient_name,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// calendar_windows — рабочие окна пачкой
// ═══════════════════════════════════════════════════════════════════════════

/**
 * args: { doctor_ids?: number[], room_ids?: number[], date:'YYYY-MM-DD', days?: 1..14 }
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ОБРАБОТЧИК, А НЕ N ВЫЗОВОВ calendar_slots. Сетка календаря
 * затеняет нерабочие часы у КАЖДОЙ показанной дорожки: шесть врачей на неделю —
 * это 42 клетки «ресурс × день». Спрашивать их по одной значило бы 42 запроса
 * на каждую перерисовку; считать их в браузере значило бы завести ЧЕТВЁРТУЮ
 * реализацию правила о рабочем дне — ровно то, из-за чего этот движок и
 * появился (см. шапку slot-engine.js). Поэтому окна отдаются пачкой, одним
 * ответом, и экран не знает о графиках, обедах и часах клиники ничего.
 *
 * Возвращает { days: ['YYYY-MM-DD', …], windows: { 'doctor:7': { '2026-09-07':
 * {from:'09:00',to:'18:00',breaks:[…]} | null } } }. null = ресурс в этот день
 * не принимает.
 */
export function calendarWindows(db, args, user) {
  requireRole(user, BOOK_ROLES);
  const a = args || {};
  const ids = (x, name) => (Array.isArray(x) ? x : []).map((v) => optId(v, name)).filter(Boolean);
  const doctorIds = ids(a.doctor_ids, 'doctor_ids');
  const roomIds = ids(a.room_ids, 'room_ids');
  if (doctorIds.length + roomIds.length === 0) return { days: [], windows: {} };
  if (doctorIds.length + roomIds.length > 200) throw new RpcError('too many resources.', 400);

  const days = Math.min(14, Math.max(1, Math.round(Number(a.days) || 1)));
  const first = localMidnight(String(a.date || '').slice(0, 10));
  const dayIsos = Array.from({ length: days }, (_, i) =>
    localDayIso(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i).getTime()));

  const doctors = doctorIds.length
    ? db.prepare(`SELECT id, working_hours, branch_id FROM users WHERE id IN (${doctorIds.map(() => '?').join(',')})`).all(...doctorIds)
    : [];
  const rooms = roomIds.length
    ? db.prepare(`SELECT id, working_hours FROM rooms WHERE id IN (${roomIds.map(() => '?').join(',')})`).all(...roomIds)
    : [];

  const out = {};
  const put = (key, res, isDoctor) => {
    const byDay = {};
    for (const dayIso of dayIsos) {
      const win = resourceWindow(db, { doctor: isDoctor ? res : null, room: isDoctor ? null : res, dayIso });
      byDay[dayIso] = win
        ? { from: formatHhmm(win.from), to: formatHhmm(win.to), breaks: (win.breaks || []).map((b) => ({ from: formatHhmm(b.from), to: formatHhmm(b.to) })) }
        : null;
    }
    out[key] = byDay;
  };
  for (const d of doctors) put('doctor:' + d.id, d, true);
  for (const r of rooms) put('room:' + r.id, r, false);
  return { days: dayIsos, windows: out };
}

// ═══════════════════════════════════════════════════════════════════════════
// calendar_book — записать, перенести, растянуть
// ═══════════════════════════════════════════════════════════════════════════

/** Текст отказа. Русский — как у остальных отказов RPC этого проекта. */
function conflictError(doctorName, conflict) {
  const from = formatHhmm(minutesOfLocal(conflict.startMs));
  const to = formatHhmm(minutesOfLocal(conflict.startMs) + conflict.durationMin);
  const params = { doctor: doctorName || '—', from, to };
  // i18n-exempt: сообщение сервера; экран переводит его по коду slot_taken
  // (шаблон в словаре, подстановка после перевода — см. rpcErrorTemplate).
  const message = `Это время занято: у врача ${params.doctor} уже есть приём ${from}–${to}. Выберите другое время.`;
  return new RpcError(message, 409, 'slot_taken', params);
}

/**
 * args:
 *   { visit_id?, patient_id?, doctor_id?, room_id?, service_id?, branch_id?,
 *     start, duration_minutes?, status?, notes?,
 *     emergency?, emergency_reason? }
 *
 * Без visit_id — создаёт запись (нужен patient_id). С visit_id — переносит
 * и/или растягивает существующую: то же действие, та же проверка, тот же отказ.
 *
 * Возвращает { visit, created, emergency }.
 */
export function calendarBook(db, args, user) {
  requireRole(user, BOOK_ROLES);
  const a = args || {};

  const visitId = optId(a.visit_id, 'visit_id');
  const existing = visitId ? db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId) : null;
  if (visitId && !existing) throw new RpcError('visit not found.', 400);

  const startMs = parseStart(a.start);
  const dayIso = localDayIso(startMs);

  // Врач/кабинет: не переданы — остаются прежними (перетаскивание по времени
  // внутри одной дорожки не должно требовать пересылки всей карточки).
  const doctorId = a.doctor_id === undefined && existing ? existing.doctor_id : optId(a.doctor_id, 'doctor_id');
  const roomId = a.room_id === undefined && existing ? existing.room_id : optId(a.room_id, 'room_id');
  const serviceId = a.service_id === undefined && existing ? existing.service_id : optId(a.service_id, 'service_id');

  if (doctorId && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(doctorId)) {
    throw new RpcError('doctor not found.', 400);
  }
  if (roomId && !db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId)) {
    throw new RpcError('room not found.', 400);
  }
  if (serviceId && !db.prepare('SELECT 1 FROM services WHERE id = ?').get(serviceId)) {
    throw new RpcError('service not found.', 400);
  }

  const durationMin = a.duration_minutes === undefined && existing
    ? Math.max(5, Number(existing.duration_minutes) || DEFAULT_DURATION_MIN)
    : resolveDuration(db, { serviceId, explicit: a.duration_minutes });

  const patientId = existing ? existing.patient_id : optId(a.patient_id, 'patient_id');
  if (!existing) {
    if (!patientId) throw new RpcError('patient_id is required.', 400);
    if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(patientId)) {
      throw new RpcError('patient not found.', 400);
    }
  }

  const status = typeof a.status === 'string' && a.status
    ? a.status
    : (existing ? existing.status : 'scheduled');

  // ─── ПРОВЕРКА ───────────────────────────────────────────────────────────
  // Только для врача (см. шапку) и только для времязанимающих статусов:
  // перевод записи в «отменён» не обязан бороться за слот, который он же и
  // освобождает.
  const emergency = a.emergency === true || a.emergency === 'true';
  const reason = typeof a.emergency_reason === 'string' ? a.emergency_reason.trim() : '';
  let conflict = null;

  if (doctorId && BUSY_STATUSES.includes(status)) {
    const busy = loadBusy(db, {
      doctorId, roomId: null,
      fromMs: startMs, toMs: startMs + durationMin * 60000,
      excludeVisitId: visitId,
    });
    conflict = busy.find((b) => overlapsMs(startMs, durationMin, b.startMs, b.durationMin)) || null;
  }

  if (conflict) {
    const doctorName = (db.prepare('SELECT full_name FROM users WHERE id = ?').get(doctorId) || {}).full_name || '';
    if (!emergency) throw conflictError(doctorName, conflict);
    if (reason.length < 3) {
      throw new RpcError(
        // i18n-exempt: сообщение сервера; ключ словаря — тот же текст.
        'Экстренная запись поверх занятого времени требует причины — укажите её.',
        400, 'emergency_reason_required',
      );
    }
  }

  // Пометка экстренной записи живёт в самой записи, а не в отдельном журнале:
  // notes уезжает филиалам (SHIPPED.visits), то есть причина доедет туда же,
  // куда доедет запись, и переживёт любую выгрузку.
  let notes = existing ? (existing.notes || '') : (typeof a.notes === 'string' ? a.notes : '');
  if (conflict && emergency) {
    const from = formatHhmm(minutesOfLocal(conflict.startMs));
    const to = formatHhmm(minutesOfLocal(conflict.startMs) + conflict.durationMin);
    // i18n-exempt: строка ПИШЕТСЯ В БАЗУ (запись о причине), а не рисуется —
    // тот же случай, что примечания к платежам и записи журнала действий.
    const mark = `Экстренная запись поверх занятого времени ${from}–${to}: ${reason}`;
    notes = notes ? notes + '\n' + mark : mark;
  }

  const visitDate = new Date(startMs).toISOString();
  const branchId = a.branch_id === undefined && existing ? existing.branch_id : optId(a.branch_id, 'branch_id');

  const run = db.transaction(() => {
    if (existing) {
      db.prepare(`
        UPDATE visits
           SET visit_date = ?, duration_minutes = ?, doctor_id = ?, room_id = ?,
               service_id = ?, status = ?, notes = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?
      `).run(visitDate, durationMin, doctorId, roomId, serviceId, status, notes, existing.id);
      return { visit: db.prepare('SELECT * FROM visits WHERE id = ?').get(existing.id), created: false };
    }
    const info = db.prepare(`
      INSERT INTO visits (patient_id, doctor_id, room_id, service_id, branch_id, visit_date,
                          duration_minutes, visit_kind, visit_type, status, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'first', 'outpatient', ?, ?, ?)
    `).run(patientId, doctorId, roomId, serviceId, branchId, visitDate, durationMin, status, notes, user && user.id);
    return { visit: db.prepare('SELECT * FROM visits WHERE id = ?').get(info.lastInsertRowid), created: true };
  });

  const out = run();
  out.emergency = !!(conflict && emergency);
  out.day = dayIso;
  return out;
}
