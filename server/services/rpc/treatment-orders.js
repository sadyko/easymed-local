// TREATMENT_ORDERS_V1 — лист назначений: сервер.
//
// Шесть RPC: врач назначает и отменяет, медсестра отмечает, старшая медсестра
// снимает отметку, экран читает лист и список задач. Экранов здесь НЕТ — их
// строит Задача 5; здесь только то, на что они обопрутся, и то, что нельзя
// доверить браузеру.
//
// ─── ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ ───────────────────────────────────────────────
//
// Своих правил маршрута. «Пациент дошёл до лечения» и «этому человеку можно
// назначать» спрашиваются у rpc/inpatient-flow.js (assertAdmissionAtLeast /
// assertCanPrescribe) — там же, где их спрашивают Задачи 2, 3 и 8. Второй
// экземпляр этих правил разошёлся бы с первым, и разошёлся бы молча.
//
// Своей арифметики расписания. Часы, дни курса и три степени опоздания живут в
// domain/mar-schedule.js — чистом модуле без базы, потому что тот же ответ
// нужен экрану врача и списанию (Задача 6).
//
// Денег. Списание со склада и начисление за введённую дозу — Задача 6. Место
// под них в схеме есть (service_id, stock_item_id, extra_consumption), но ни
// одной строки в invoices/stock_movements этот файл не пишет.

import {
  RpcError, loadAdmission, assertAdmissionAtLeast, assertCanPrescribe,
} from './inpatient-flow.js';
import { hasAnyRole } from '../roles.js';
import { today } from '../domain/day.js';
import {
  FREQ_CODES, ROUTES, freqSlots, isPrnFreq,
  expandCourse, courseEnd, dueState, isDate,
} from '../domain/mar-schedule.js';

export { RpcError };

// ─── Роли ───────────────────────────────────────────────────────────────────
//
// Матрица плана (раздел «Роли»), дословно:
//   создать/отменить назначение   — врач (свой пациент), главный врач, admin
//                                   → это и есть assertCanPrescribe;
//   отметить выполнение дозы      — медсестра, старшая медсестра, admin;
//   снять отметку                 — ТОЛЬКО старшая медсестра и admin.
//
// Разница между двумя последними строками — весь смысл отдельного RPC на
// снятие: поставить отметку может любая медсестра, отменить чужую — только
// старшая. Врача в них нет намеренно: доза либо введена, либо нет, и это
// сестринская запись.
const MARK_ROLES = ['nurse', 'senior_nurse', 'admin'];
const UNMARK_ROLES = ['senior_nurse', 'admin'];
// Читают лист все, кто ведёт пациента в отделении. Касса и склад — нет: лист
// назначений это история болезни, а не счёт.
const READ_ROLES = ['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];

const KINDS = ['med', 'infusion', 'proc', 'care'];
const SOURCES = ['clinic', 'patient'];
const MARK_STATUSES = ['given', 'refused', 'missed', 'held'];
// Отметка без причины допустима ровно для одной: «дала».
const STATUS_NEEDS_REASON = MARK_STATUSES.filter((s) => s !== 'given');

function requireRole(user, allowed, what) {
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError(`${what} — недоступно вашей роли.`, 403);
  }
}

// Время в том же виде, в каком его пишут DEFAULT'ы всех таблиц (UTC).
function nowUtc(db) {
  return db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') t").get().t;
}

function str(v, max, fallback = '') {
  if (v === null || v === undefined) return fallback;
  return String(v).trim().slice(0, max);
}

function posIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Ссылка на справочник существует — или понятный отказ вместо ошибки FK (500). */
function refOrNull(db, table, id, what) {
  const n = posIntOrNull(id);
  if (n === null) return null;
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(n);
  if (!row) throw new RpcError(`${what} не найдена (id ${n}).`, 400);
  return n;
}

function loadOrder(db, orderId) {
  const id = posIntOrNull(orderId);
  if (id === null) throw new RpcError('order_id must be a positive integer.', 400);
  const row = db.prepare('SELECT * FROM treatment_orders WHERE id = ?').get(id);
  if (!row) throw new RpcError('Назначение не найдено.', 400);
  return row;
}

// ─── 1. Создать назначение ──────────────────────────────────────────────────

/**
 * Назначение врача. Первая строка — охранник маршрута: пациент обязан дойти до
 * 'active' (осмотрен главным врачом, лечащий врач назначен), а назначает
 * лечащий врач СВОЕГО пациента, главный врач или администратор. Оба вопроса
 * задаёт assertCanPrescribe, и её отказ называет недостающий шаг словами.
 */
export function treatmentOrderCreate(db, args, user) {
  const a = args || {};
  const adm = assertCanPrescribe(db, a.admission_id, user);

  const kind = str(a.kind, 20, 'med') || 'med';
  if (!KINDS.includes(kind)) throw new RpcError(`Неизвестный род назначения: ${kind}.`, 400);

  const name = str(a.name, 200);
  if (!name) throw new RpcError('Назначение без названия сохранить нельзя.', 400);

  const freqCode = str(a.freq_code, 20, '1x') || '1x';
  if (!FREQ_CODES.includes(freqCode)) throw new RpcError(`Неизвестная частота: ${freqCode}.`, 400);

  const route = a.route === null || a.route === undefined || a.route === '' ? null : str(a.route, 40);
  if (route !== null && !ROUTES.includes(route)) {
    throw new RpcError(`Неизвестный путь введения: ${route}.`, 400);
  }
  // «Пять прав» медсестры включают путь введения, и у препарата он есть всегда
  // (хотя бы «внутрь»). У процедуры и ухода пути нет — там NULL законен.
  if (route === null && (kind === 'med' || kind === 'infusion')) {
    throw new RpcError('Укажите путь введения.', 400);
  }

  const source = str(a.source, 20, 'clinic') || 'clinic';
  if (!SOURCES.includes(source)) throw new RpcError(`Неизвестный источник препарата: ${source}.`, 400);

  const startsOn = a.starts_on ? str(a.starts_on, 10) : today(db);
  if (!isDate(startsOn)) throw new RpcError('Дата начала курса должна быть в виде ГГГГ-ММ-ДД.', 400);

  const prn = isPrnFreq(freqCode) ? 1 : 0;
  // У «по требованию» курса нет: ни часов, ни срока. Молча принять days от
  // экрана значило бы записать в базу срок, который никто не считает.
  const days = prn ? null : posIntOrNull(a.days);
  const slots = prn ? [] : freqSlots(freqCode);
  const endsOn = prn ? null : courseEnd(startsOn, days, freqCode);

  const serviceId = refOrNull(db, 'services', a.service_id, 'Услуга');
  const stockItemId = refOrNull(db, 'products', a.stock_item_id, 'Позиция склада');

  const isInfusion = kind === 'infusion';
  const at = nowUtc(db);

  const info = db.prepare(`INSERT INTO treatment_orders
      (admission_id, kind, name, service_id, stock_item_id, dose, route,
       freq_code, slots, prn, starts_on, days, ends_on,
       prescribed_by, prescribed_at, source, status,
       volume, rate_ml_h, duration_min, continuous, note)
    VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?, 'active', ?,?,?,?,?)`).run(
    adm.id, kind, name, serviceId, stockItemId, str(a.dose, 100), route,
    freqCode, JSON.stringify(slots), prn, startsOn, days, endsOn,
    (user && user.id) || null, at, source,
    isInfusion ? numOrNull(a.volume) : null,
    isInfusion ? numOrNull(a.rate_ml_h) : null,
    isInfusion ? posIntOrNull(a.duration_min) : null,
    isInfusion && (a.continuous === 1 || a.continuous === true) ? 1 : 0,
    str(a.note, 500),
  );

  return { order: db.prepare('SELECT * FROM treatment_orders WHERE id = ?').get(info.lastInsertRowid) };
}

// ─── 2. Отменить назначение ─────────────────────────────────────────────────

/**
 * Отмена НЕ УДАЛЯЕТ ничего: назначение остаётся в листе зачёркнутым, с
 * причиной и автором, и все уже сделанные отметки при нём (ловушка референса,
 * названная в плане). Расписание после отмены просто перестаёт рождать новые
 * плановые точки — с МОМЕНТА отмены, а не с её даты (см. expandCourse).
 */
export function treatmentOrderCancel(db, args, user) {
  const a = args || {};
  const order = loadOrder(db, a.order_id);
  assertCanPrescribe(db, order.admission_id, user);

  const reason = str(a.reason, 300);
  if (!reason) throw new RpcError('Отмена назначения без причины невозможна.', 400);

  // Повторное нажатие — не ошибка человека, а двойной клик.
  if (order.status === 'cancelled') return { order, already: true };
  if (order.status === 'finished') {
    throw new RpcError('Курс уже завершён — отменять нечего.', 400);
  }

  const at = nowUtc(db);
  db.prepare(`UPDATE treatment_orders
                 SET status = 'cancelled', cancel_reason = ?, cancel_note = ?,
                     cancel_by = ?, cancel_at = ?
               WHERE id = ?`)
    .run(reason, str(a.note, 500), (user && user.id) || null, at, order.id);

  return { order: db.prepare('SELECT * FROM treatment_orders WHERE id = ?').get(order.id), already: false };
}

// ─── 3. Лист назначений одной госпитализации ────────────────────────────────

function parseSlots(order) {
  try {
    const v = JSON.parse(order.slots || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/**
 * Лист за период: назначения + развёрнутые плановые точки + отметки.
 *
 * СОСТОЯНИЕ ГОСПИТАЛИЗАЦИИ ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ, и это осознанно. Читать лист
 * выписанного пациента обязаны все: история болезни живёт дольше койки, и
 * assertAdmissionAtLeast(...,'active') отказала бы именно на закрытой
 * госпитализации — то есть ровно тогда, когда лист чаще всего и открывают.
 * Записи (создание, отметка, снятие) охранник проверяют, чтение — нет.
 */
export function treatmentOrdersList(db, args, user) {
  requireRole(user, READ_ROLES, 'Лист назначений');
  const a = args || {};
  const adm = loadAdmission(db, a.admission_id);

  const from = a.from && isDate(str(a.from, 10)) ? str(a.from, 10) : today(db);
  const to = a.to && isDate(str(a.to, 10)) ? str(a.to, 10) : from;
  if (to < from) throw new RpcError('Конец периода раньше его начала.', 400);

  const includeCancelled = a.include_cancelled === true || a.include_cancelled === 1;

  // Курс попадает в окно, если он начался не позже его конца и не кончился
  // раньше начала. «До отмены» (ends_on IS NULL) не кончается никогда.
  const rows = db.prepare(`
    SELECT * FROM treatment_orders
     WHERE admission_id = ?
       AND starts_on <= ?
       AND (ends_on IS NULL OR ends_on >= ?)
       ${includeCancelled ? '' : "AND status <> 'cancelled'"}
     ORDER BY prn, starts_on, id`).all(adm.id, to, from);

  const marks = db.prepare(`
    SELECT * FROM treatment_administrations
     WHERE order_id IN (SELECT id FROM treatment_orders WHERE admission_id = ?)
       AND due_date BETWEEN ? AND ?
     ORDER BY due_date, due_slot, id`).all(adm.id, from, to);

  const byOrder = new Map();
  for (const m of marks) {
    if (!byOrder.has(m.order_id)) byOrder.set(m.order_id, []);
    byOrder.get(m.order_id).push(m);
  }

  const orders = rows.map((o) => {
    const mine = byOrder.get(o.id) || [];
    const live = mine.filter((m) => !m.voided_at);
    return {
      ...o,
      slot_hours: parseSlots(o),
      due: expandCourse(o, from, to),
      // Отметки, которые считаются: снятые отдаются отдельно — они след, а не
      // выполнение (лист врача рисует их как снятые).
      marks: live,
      voided_marks: mine.filter((m) => m.voided_at),
      prn_marks: live.filter((m) => m.due_slot === null),
    };
  });

  return { admission_id: adm.id, from, to, include_cancelled: includeCancelled, orders };
}

// ─── 4. Отметка медсестры ───────────────────────────────────────────────────

function liveMark(db, orderId, date, slot) {
  return db.prepare(`SELECT * FROM treatment_administrations
                      WHERE order_id = ? AND due_date = ? AND due_slot IS ?
                        AND voided_at IS NULL`).get(orderId, date, slot);
}

/**
 * Закрыть одну плановую точку: дала / отказался / пропущено / придержано.
 *
 * Ключ — (назначение, ДАТА, слот). Повторное нажатие тем же статусом ничего не
 * создаёт и возвращает ту же строку: у медсестры экран на общем планшете, и
 * двойное нажатие обязано быть безобидным. Попытка ПЕРЕПИСАТЬ уже стоящую
 * отметку другим статусом отвергается — это не отметка, а исправление чужой
 * записи, и его делает старшая медсестра через treatment_admin_unmark.
 *
 * PRN («по требованию») отмечается БЕЗ слота: плановых точек у него нет, две
 * инъекции за день — норма, и единственность по (дата, слот) на них не
 * распространяется (частичный UNIQUE в миграции 093).
 */
export function treatmentAdminMark(db, args, user) {
  requireRole(user, MARK_ROLES, 'Отметка выполнения');
  const a = args || {};
  const order = loadOrder(db, a.order_id);
  assertAdmissionAtLeast(db, order.admission_id, 'active');

  const status = str(a.status, 20, 'given') || 'given';
  if (!MARK_STATUSES.includes(status)) throw new RpcError(`Неизвестный статус отметки: ${status}.`, 400);

  const reason = str(a.reason, 300);
  if (STATUS_NEEDS_REASON.includes(status) && !reason) {
    throw new RpcError('Отказ, пропуск и задержку дозы записывают только с причиной.', 400);
  }

  const date = a.date ? str(a.date, 10) : today(db);
  if (!isDate(date)) throw new RpcError('Дата дозы должна быть в виде ГГГГ-ММ-ДД.', 400);

  const isPrn = order.prn === 1;
  let slot = null;
  if (isPrn) {
    if (a.slot !== undefined && a.slot !== null && a.slot !== '') {
      throw new RpcError('Назначение «по требованию» не имеет часов — отметка идёт без слота.', 400);
    }
  } else {
    // null/пусто — это НЕ полночь. Number(null) === 0, и без явной проверки
    // отметка без часа молча уехала бы в слот 0.
    const n = a.slot === null || a.slot === undefined || a.slot === '' ? NaN : Number(a.slot);
    if (!Number.isInteger(n) || n < 0 || n > 23) {
      throw new RpcError('Укажите час дозы (0–23).', 400);
    }
    slot = n;
    // Час должен быть НАСТОЯЩЕЙ точкой этого курса: не выдуманный слот, не
    // день до начала, не день после конца и не то, что уже отменено. Один
    // источник правды — то же расписание, по которому рисуется лист.
    const planned = expandCourse(order, date, date).some((d) => d.slot === slot);
    if (!planned) {
      throw new RpcError('Этой дозы нет в расписании назначения.', 400);
    }
  }

  const existing = isPrn ? null : liveMark(db, order.id, date, slot);
  if (existing) {
    if (existing.status === status) return { administration: existing, already: true };
    throw new RpcError('Отметка на этот час уже стоит. Снять её может старшая медсестра.', 400);
  }

  let extra = null;
  if (a.extra !== undefined && a.extra !== null && a.extra !== '') {
    extra = typeof a.extra === 'string' ? a.extra.slice(0, 2000) : JSON.stringify(a.extra).slice(0, 2000);
  }

  const at = nowUtc(db);
  const info = db.prepare(`INSERT INTO treatment_administrations
      (order_id, due_date, due_slot, status, given_at, given_by, reason, note, extra_consumption)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    order.id, date, slot, status, at, (user && user.id) || null,
    reason, str(a.note, 500), extra,
  );

  return {
    administration: db.prepare('SELECT * FROM treatment_administrations WHERE id = ?').get(info.lastInsertRowid),
    already: false,
  };
}

// ─── 5. Снять отметку ───────────────────────────────────────────────────────

/**
 * Только старшая медсестра и администратор (матрица плана), и строка НЕ
 * УДАЛЯЕТСЯ — в этом отличие от референса, где снятая отметка исчезает
 * бесследно и разобраться, кто и что снял, уже невозможно. Здесь остаётся
 * след: кто снял, когда и почему; из действующих строку выводит voided_at, и
 * слот снова свободен для верной отметки.
 */
export function treatmentAdminUnmark(db, args, user) {
  requireRole(user, UNMARK_ROLES, 'Снятие отметки');
  const a = args || {};
  const id = posIntOrNull(a.administration_id);
  if (id === null) throw new RpcError('administration_id must be a positive integer.', 400);

  const row = db.prepare('SELECT * FROM treatment_administrations WHERE id = ?').get(id);
  if (!row) throw new RpcError('Отметка не найдена.', 400);
  if (row.voided_at) return { administration: row, already: true };

  const reason = str(a.reason, 300);
  if (!reason) throw new RpcError('Снятие отметки без причины невозможно.', 400);

  const order = loadOrder(db, row.order_id);
  assertAdmissionAtLeast(db, order.admission_id, 'active');

  const at = nowUtc(db);
  db.prepare(`UPDATE treatment_administrations
                 SET voided_at = ?, voided_by = ?, void_reason = ?
               WHERE id = ?`)
    .run(at, (user && user.id) || null, reason, row.id);

  return {
    administration: db.prepare('SELECT * FROM treatment_administrations WHERE id = ?').get(row.id),
    already: false,
  };
}

// ─── 6. Задачи медсестры на смену ───────────────────────────────────────────

// Куда попадает плановая точка на экране медсестры. Четыре группы плана:
// Просрочено / Сейчас / Позже / По требованию.
//
// 'delayed' идёт в «Сейчас», а не в «Просрочено», и это несущее решение: доза,
// опоздавшая на двадцать минут, — работа, которую надо сделать НЕМЕДЛЕННО, а
// «Просрочено» — список, по которому потом объясняются. Смешай их, и группа
// «Просрочено» к вечеру станет длиной в смену, а значит её перестанут читать.
const SOON_MIN = 60;

function groupOf(state, dueMs, nowMs) {
  if (state === 'missed') return 'overdue';
  if (state === 'delayed') return 'now';
  return dueMs - nowMs <= SOON_MIN * 60000 ? 'now' : 'later';
}

/**
 * Что медсестре делать сейчас — по всему отделению, а не по одному пациенту.
 *
 * Пациент здесь якорь (правило Задачи 5): каждая задача несёт палату, койку и
 * имя, потому что ошибка «не тот пациент» — то, против чего этот экран и
 * строится.
 */
export function treatmentTasksDue(db, args, user) {
  requireRole(user, READ_ROLES, 'Список задач');
  const a = args || {};

  const date = a.date && isDate(str(a.date, 10)) ? str(a.date, 10) : today(db);
  // Время сравнения — местное (слоты это часы настенных часов отделения, см.
  // domain/mar-schedule.js). Параметр `now` существует ради тестов и разбора
  // прошедшей смены.
  const nowMs = a.now ? Date.parse(a.now) : Date.now();
  if (Number.isNaN(nowMs)) throw new RpcError('now must be a timestamp.', 400);

  const wardId = posIntOrNull(a.ward_id);

  // Лечение идёт у тех, кто дошёл до 'active' и ещё не выписан. 'admitted' и
  // 'examined' сюда не попадают: до назначения лечащего врача назначений не
  // существует вовсе (assertCanPrescribe их не пропустит).
  const rows = db.prepare(`
    SELECT o.*,
           adm.id AS admission_id, adm.patient_id, adm.ward_id, adm.bed_id,
           p.full_name AS patient_name, w.name AS ward_name, b.code AS bed_code
      FROM treatment_orders o
      JOIN admissions adm ON adm.id = o.admission_id
      LEFT JOIN patients p ON p.id = adm.patient_id
      LEFT JOIN wards w ON w.id = adm.ward_id
      LEFT JOIN beds b ON b.id = adm.bed_id
     WHERE o.status = 'active'
       AND adm.status IN ('active','discharging')
       AND o.starts_on <= ?
       AND (o.ends_on IS NULL OR o.ends_on >= ?)
       ${wardId === null ? '' : 'AND adm.ward_id = ?'}
     ORDER BY w.name, b.code, p.full_name, o.id`)
    .all(...(wardId === null ? [date, date] : [date, date, wardId]));

  const marked = new Set();
  const prnCount = new Map();
  for (const m of db.prepare(`
    SELECT order_id, due_slot FROM treatment_administrations
     WHERE due_date = ? AND voided_at IS NULL`).all(date)) {
    if (m.due_slot === null) prnCount.set(m.order_id, (prnCount.get(m.order_id) || 0) + 1);
    else marked.add(`${m.order_id}|${m.due_slot}`);
  }

  const groups = { overdue: [], now: [], later: [], prn: [] };

  for (const o of rows) {
    const patient = {
      admission_id: o.admission_id, patient_id: o.patient_id, patient_name: o.patient_name,
      ward_id: o.ward_id, ward_name: o.ward_name, bed_id: o.bed_id, bed_code: o.bed_code,
    };
    const drug = {
      order_id: o.id, kind: o.kind, name: o.name, dose: o.dose, route: o.route,
      source: o.source, freq_code: o.freq_code, prn: o.prn,
      service_id: o.service_id, stock_item_id: o.stock_item_id,
    };

    if (o.prn === 1) {
      groups.prn.push({ ...patient, ...drug, date, given_today: prnCount.get(o.id) || 0 });
      continue;
    }

    for (const due of expandCourse(o, date, date)) {
      if (marked.has(`${o.id}|${due.slot}`)) continue;   // уже закрыта
      const state = dueState(due, nowMs);
      groups[groupOf(state, due.due_ms, nowMs)].push({
        ...patient, ...drug,
        date: due.date, slot: due.slot, due_at: due.due_at, state,
        late_min: Math.max(0, Math.round((nowMs - due.due_ms) / 60000)),
      });
    }
  }

  for (const key of ['overdue', 'now', 'later']) {
    groups[key].sort((x, y) => (x.slot - y.slot) || String(x.patient_name).localeCompare(String(y.patient_name)));
  }

  return {
    date,
    now: new Date(nowMs).toISOString(),
    ward_id: wardId,
    counts: {
      overdue: groups.overdue.length, now: groups.now.length,
      later: groups.later.length, prn: groups.prn.length,
    },
    groups,
  };
}
