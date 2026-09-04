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
// Своего движения товара. Отметка «дала» ДЕЙСТВИТЕЛЬНО списывает препарат и
// начисляет за него (MED_ADMIN_CHARGE_V1, ниже), но остаток, строка
// admission_services и запись в stock_movements пишутся кодом склада
// (rpc/inventory.js, dispenseAdmissionItemCore) — тем же самым, что и у койки.
// Своя копия разъехалась бы с ней молча.
//
// Ни одной строки в `invoices` этот файл по-прежнему не пишет: начисление —
// это строка admission_services, а в счёт её собирает касса
// (billing.js create_invoice_for_admission), как и всякую другую услугу
// госпитализации. Предупреждение из шапки 084_sync_journal.sql соблюдено.

import {
  RpcError, loadAdmission, assertAdmissionAtLeast, assertCanPrescribe,
} from './inpatient-flow.js';
import { hasAnyRole } from '../roles.js';
import { today } from '../domain/day.js';
import {
  FREQ_CODES, ROUTES, freqSlots, isPrnFreq,
  expandCourse, courseEnd, dueState, isDate,
} from '../domain/mar-schedule.js';
// MED_ADMIN_CHARGE_V1 — склад и деньги за введённую дозу.
import { doseQuantity } from '../domain/dose.js';
// StockError — это ДРУГОЙ класс, не тот RpcError, что импортирован выше:
// inventory.js объявляет свой (как и accommodation.js), и они не родственники.
// Псевдоним стоит здесь не для красоты: отказ склада ловится по классу, и
// `instanceof RpcError` молча не поймал бы ничего — «нет остатка» улетело бы
// наружу отказом всей отметки, то есть ровно тем запретом, которого план
// велит избегать («Нет остатка — предупреждение, а не запрет»).
import {
  dispenseAdmissionItemCore, voidDispensedAdmissionItemCore, RpcError as StockError,
} from './inventory.js';
import {
  doseNotePrefix, extraNotePrefix, administrationNotePrefix,
} from '../../../public/js/shared/med-admin-line.js';

export { RpcError };

// ─── Роли ───────────────────────────────────────────────────────────────────
//
// Матрица плана (раздел «Роли»), дословно:
//   создать/отменить назначение   — врач (свой пациент), главный врач, admin
//                                   → это и есть assertCanPrescribe;
//   отметить выполнение дозы      — медсестра, старшая медсестра, admin;
//   снять отметку                 — старшая медсестра и admin без ограничений,
//                                   медсестра — свою и по горячим следам
//                                   (UNMARK_WINDOW_V1 ниже).
//
// Разница между двумя последними строками — весь смысл отдельного RPC на
// снятие: поставить отметку может любая медсестра, отменить ЧУЖУЮ (или свою,
// но остывшую) — только старшая. Врача в них нет намеренно: доза либо введена,
// либо нет, и это сестринская запись.
const MARK_ROLES = ['nurse', 'senior_nurse', 'admin'];
// Кого RPC снятия вообще пускает на порог. Кто из них что может — решает
// unmarkVerdict, и только он.
const UNMARK_ROLES = ['nurse', 'senior_nurse', 'admin'];
// Снимают без оглядки на автора и на часы.
const UNMARK_ANY_ROLES = ['senior_nurse', 'admin'];
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

  // MED_ADMIN_CHARGE_V1 — сколько единиц склада уходит на ОДНУ дозу.
  //
  // Необязательно, и в этом вся мысль: `dose` — свободный текст врача, и «1 г»
  // при складе в штуках количества не даёт (см. domain/dose.js). Когда экран
  // назначения знает ответ — он говорит его здесь, и списание перестаёт
  // зависеть от разбора текста. Когда не знает — доза разбирается, а не
  // угадывается, и неудача становится видимой (stock_status).
  const stockQty = numOrNull(a.stock_qty);
  if (stockQty !== null && !(stockQty > 0)) {
    throw new RpcError('Количество для списания должно быть больше нуля.', 400);
  }

  const isInfusion = kind === 'infusion';
  const at = nowUtc(db);

  const info = db.prepare(`INSERT INTO treatment_orders
      (admission_id, kind, name, service_id, stock_item_id, stock_qty, dose, route,
       freq_code, slots, prn, starts_on, days, ends_on,
       prescribed_by, prescribed_at, source, status,
       volume, rate_ml_h, duration_min, continuous, note)
    VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?, 'active', ?,?,?,?,?)`).run(
    adm.id, kind, name, serviceId, stockItemId, stockQty, str(a.dose, 100), route,
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

  // MED_ADMIN_CHARGE_V1 — НЕСПИСАННОЕ. Отметка «дала», за которой не пошёл
  // склад (количество не выведено из дозы, либо остатка не хватило), — это
  // работа для человека, и она обязана быть на виду. Молча она нашлась бы при
  // инвентаризации, через месяц, когда уже нельзя вспомнить, что вводили.
  const issues = db.prepare(`
    SELECT a.id, a.order_id, a.due_date, a.due_slot, a.stock_status, a.stock_note,
           o.name, o.dose, o.stock_item_id
      FROM treatment_administrations a
      JOIN treatment_orders o ON o.id = a.order_id
     WHERE o.admission_id = ?
       AND a.voided_at IS NULL
       AND a.due_date BETWEEN ? AND ?
       AND a.stock_status IN (${STOCK_ISSUE.map(() => '?').join(',')})
     ORDER BY a.due_date, a.due_slot, a.id`).all(adm.id, from, to, ...STOCK_ISSUE);

  return {
    admission_id: adm.id, from, to, include_cancelled: includeCancelled, orders,
    stock_issues: { count: issues.length, items: issues },
  };
}

// ─── MED_ADMIN_CHARGE_V1 — склад и деньги за введённую дозу ─────────────────
//
// Медсестра нажала «дала». С этой секунды в клинике произошли ТРИ разные вещи,
// и путать их нельзя:
//
//   1. МЕДИЦИНСКИЙ ФАКТ — доза введена. Записывается ВСЕГДА и ничем не
//      отменяется: ни пустым складом, ни непонятной дозой, ни погашенной
//      позицией. История болезни не зависит от состояния склада.
//   2. СКЛАД — препарат физически ушёл. Может не получиться (нет остатка,
//      количество не выводится из дозы) — и тогда это ПРЕДУПРЕЖДЕНИЕ, а не
//      запрет (правило плана: «Нет остатка — предупреждение»).
//   3. ДЕНЬГИ — строка admission_services, которую касса соберёт в счёт стаци-
//      онара наравне с проживанием и процедурами.
//
// Пункты 2 и 3 — ОДНА пара и делаются одним вызовом склада
// (dispenseAdmissionItemCore): не бывает списанного, но не начисленного, и не
// бывает начисленного, но не списанного. Если склад отказал — нет ни того, ни
// другого, и человек об этом слышит; тогда провести препарат вручную можно
// консолью койки, ровно как раньше.
//
// ─── ИДЕМПОТЕНТНОСТЬ ────────────────────────────────────────────────────────
//
// Три замка, и каждый держит сам по себе:
//   • частичный UNIQUE (order_id, due_date, due_slot) в миграции 093;
//   • ранний возврат по liveMark — повторное нажатие тем же статусом даже не
//     доходит сюда;
//   • сами строки счёта помечены id ОТМЕТКИ (shared/med-admin-line.js), и
//     перед списанием мы смотрим, нет ли их уже. Это последний замок: он
//     работает, даже если первые два кто-то обойдёт.
// Снятие отметки ищет по той же метке — и после первого снятия строк уже нет,
// поэтому второе снятие возвращать нечего (а до него оно и не дойдёт: voided_at
// отвечает раньше).

// Порядок «серьёзности» складского исхода: итог отметки — САМЫЙ ПЛОХОЙ из
// случившегося. Одна списанная доза не отменяет одну несписанную ампулу.
const STOCK_RANK = { '': 0, none: 1, ok: 2, reversed: 2, skipped: 3, short: 4 };
const STOCK_ISSUE = ['skipped', 'short'];

function worseStock(a, b) {
  return (STOCK_RANK[b] || 0) > (STOCK_RANK[a] || 0) ? b : a;
}

/** Все строки счёта, рождённые этой отметкой (и дозу, и расход сверх неё). */
function administrationLines(db, administrationId) {
  return db.prepare('SELECT * FROM admission_services WHERE notes LIKE ? ORDER BY id')
    .all(`${administrationNotePrefix(administrationId)}%`);
}

/**
 * Начисленное этой отметкой — в виде, годном для экрана.
 *
 * ЧИТАЕТСЯ ИЗ БАЗЫ, а не собирается по дороге, и это осознанно: ответ на
 * первое нажатие и ответ на повторное обязаны быть ОДНОЙ формы. Собери мы
 * первый из возвратов склада, а второй запросом — экран получал бы то
 * `line_id`, то `id`, и «повторное нажатие» выглядело бы как несостоявшееся
 * списание ровно там, где оно как раз состоялось.
 */
function chargeSummary(db, administrationId) {
  return db.prepare(`
    SELECT s.id AS line_id, s.clinic_item_id AS product_id, p.name AS item_name,
           s.quantity, s.unit_price, s.total, s.billable, s.invoice_item_id, s.notes
      FROM admission_services s
      LEFT JOIN products p ON p.id = s.clinic_item_id
     WHERE s.notes LIKE ? ORDER BY s.id`)
    .all(`${administrationNotePrefix(administrationId)}%`)
    .map((r) => ({ ...r, kind: r.notes.includes('/extra:') ? 'extra' : 'dose' }));
}

/**
 * Расход СВЕРХ дозы, записанный медсестрой у койки: разбитая ампула, второй
 * шприц. JSON-текст `[{product_id, qty}]` (миграция 093).
 *
 * Одинаковые позиции складываются: две записи об одном товаре — это один
 * расход в две строки, а не два расхода. Метка строки счёта содержит
 * product_id, и два расхода одного товара получили бы одинаковую метку, то
 * есть перестали бы различаться при снятии.
 */
function parseExtraConsumption(raw) {
  if (raw === null || raw === undefined || raw === '') return { items: [], unreadable: false };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { items: [], unreadable: true }; }
  if (!Array.isArray(parsed)) return { items: [], unreadable: true };

  const byProduct = new Map();
  let unreadable = false;
  for (const e of parsed) {
    if (!e || typeof e !== 'object') { unreadable = true; continue; }
    const pid = posIntOrNull(e.product_id !== undefined ? e.product_id : e.stock_item_id);
    const qtyRaw = e.qty !== undefined ? e.qty : e.quantity;
    const qty = Number(qtyRaw);
    if (pid === null || !Number.isFinite(qty) || qty <= 0) { unreadable = true; continue; }
    const prev = byProduct.get(pid);
    // billable: false — «в учёт расходов, не в счёт пациенту». Разбитую
    // медсестрой ампулу клиника вправе не выставлять больному, и это её
    // решение, а не наше: по умолчанию строка идёт в счёт, как всякий расходник.
    const billable = e.billable === false || e.billable === 0 ? 0 : 1;
    if (prev) { prev.quantity += qty; prev.billable = prev.billable && billable; }
    else byProduct.set(pid, { product_id: pid, quantity: qty, billable, name: str(e.name, 100) });
  }
  return { items: [...byProduct.values()], unreadable };
}

/**
 * Списать и начислить за одну отметку. Возвращает исход, НЕ бросает: срыв
 * склада — предупреждение, а не отказ от медицинской записи.
 *
 * Вызывается ВНУТРИ транзакции отметки. Склад открывает свою (better-sqlite3
 * делает вложенную транзакцию SAVEPOINT'ом), поэтому его отказ откатывает
 * ровно свою половину — остаток и строка счёта, — а отметка остаётся.
 */
function chargeAdministration(db, order, administration, user) {
  const warnings = [];
  const notes = [];

  // Последний замок идемпотентности: за эту отметку уже начислено.
  if (administrationLines(db, administration.id).length) {
    return {
      stock_status: administration.stock_status || 'ok',
      stock_note: administration.stock_note || '',
      lines: chargeSummary(db, administration.id), warnings, already: true, basis: null,
    };
  }

  let stockStatus = 'none';
  // Откуда взялось количество дозы: явно из назначения, счётом или приведением
  // единиц. Экран показывает это рядом с «списано 1 шт», чтобы медсестра
  // видела, ЧЕМУ она верит.
  let basis = null;

  // ─── 1. Сама доза ───────────────────────────────────────────────────────
  //
  // Препарат ПАЦИЕНТА (source='patient') не списывают и не начисляют — его
  // принесли родственники, склада он не касался (правило Задачи 6). Отметка о
  // введении при этом делается точно такая же: лечение состоялось.
  //
  // Назначение без ссылки на склад (уход, режим, процедура) — тоже 'none': не
  // ошибка, а нечего списывать.
  if (order.source === 'clinic' && order.stock_item_id) {
    const product = db.prepare('SELECT id, name, unit FROM products WHERE id = ?').get(order.stock_item_id);
    const q = doseQuantity({
      dose: order.dose,
      stock_qty: order.stock_qty,
      product_unit: product ? product.unit : null,
    });
    if (!q.ok) {
      // НЕ УГАДЫВАЕМ. Отметка записана, списание пропущено, и это видно
      // человеку (stock_status='skipped' считается отдельно).
      stockStatus = worseStock(stockStatus, 'skipped');
      notes.push(q.message);
      warnings.push({ code: 'quantity', reason: q.reason, message: q.message });
    } else {
      try {
        dispenseAdmissionItemCore(db, {
          admission_id: order.admission_id,
          product_id: order.stock_item_id,
          quantity: q.quantity,
          doctor_id: order.prescribed_by,
          billable: true,
          note: `${doseNotePrefix(administration.id)}${order.name}${order.dose ? ` · ${order.dose}` : ''}`,
        }, user);
        stockStatus = worseStock(stockStatus, 'ok');
        basis = q.basis;
      } catch (e) {
        // Нет остатка / позиция погашена / товара нет в каталоге. Склад ведёт
        // себя ТОЧНО КАК В АМБУЛАТОРИИ: он не уходит в минус и отказывает
        // целиком (inventory.js dispenseItem). Разница только в том, что здесь
        // отказ не отменяет отметку — он становится предупреждением.
        if (!(e instanceof StockError)) throw e;
        stockStatus = worseStock(stockStatus, 'short');
        notes.push(`не списано: ${e.message}`);
        warnings.push({ code: 'stock', message: e.message });
      }
    }
  }

  // ─── 2. Расход сверх дозы ───────────────────────────────────────────────
  //
  // ОТДЕЛЬНОЙ строкой, а не прибавкой к дозе (правило референса): разбитая
  // ампула должна быть ВИДНА. Спрятав её в количество дозы, мы получили бы
  // «введено 2 г» там, где ввели 1, — то есть враньё в истории болезни ради
  // аккуратности склада.
  //
  // Списывается при ЛЮБОМ источнике, включая препарат пациента: сверхрасход
  // назван product_id — это позиция КЛИНИЧЕСКОГО склада (шприц, разбитая
  // ампула физраствора), и она ушла со склада независимо от того, чей был сам
  // препарат.
  const extra = parseExtraConsumption(administration.extra_consumption);
  if (extra.unreadable && extra.items.length === 0) {
    const msg = 'расход сверх дозы записан текстом — списать его сможет только человек';
    notes.push(msg);
    warnings.push({ code: 'extra_unreadable', message: msg });
  }
  for (const item of extra.items) {
    try {
      dispenseAdmissionItemCore(db, {
        admission_id: order.admission_id,
        product_id: item.product_id,
        quantity: item.quantity,
        doctor_id: order.prescribed_by,
        billable: !!item.billable,
        note: `${extraNotePrefix(administration.id, item.product_id)}${item.name || 'расход сверх дозы'}`,
      }, user);
      stockStatus = worseStock(stockStatus, 'ok');
    } catch (e) {
      if (!(e instanceof StockError)) throw e;
      stockStatus = worseStock(stockStatus, 'short');
      notes.push(`расход сверх дозы не списан: ${e.message}`);
      warnings.push({ code: 'stock_extra', product_id: item.product_id, message: e.message });
    }
  }

  const stockNote = notes.join(' · ').slice(0, 1000);
  db.prepare('UPDATE treatment_administrations SET stock_status = ?, stock_note = ? WHERE id = ?')
    .run(stockStatus, stockNote, administration.id);

  return {
    stock_status: stockStatus, stock_note: stockNote,
    lines: chargeSummary(db, administration.id), warnings, already: false, basis,
  };
}

/**
 * Вернуть склад и убрать начисление — обратная сторона отметки.
 *
 * ВЫСТАВЛЕННУЮ строку не трогаем: за ней уже стоят деньги пациента, и убрать
 * её должна касса своим путём (то же правило и та же фраза, что у проживания в
 * rpc/accommodation.js). Молчать при этом нельзя — иначе снятие выглядело бы
 * полным, а счёт продолжал бы требовать деньги за неведённую дозу.
 */
function reverseAdministration(db, administration, user) {
  const lines = administrationLines(db, administration.id);
  const warnings = [];
  let reversed = 0;
  let kept = 0;

  for (const line of lines) {
    if (line.invoice_item_id != null) {
      kept += 1;
      warnings.push({ code: 'invoiced', line_id: line.id,
                      message: 'Строка уже в счёте — уберите её через кассу.' });
      continue;
    }
    // Тот же код возврата, что у консоли койки: остаток обратно, движение
    // 'void' в журнал, строка удалена.
    voidDispensedAdmissionItemCore(db, { line_id: line.id }, user);
    reversed += 1;
  }

  if (lines.length) {
    const note = kept
      ? `снято; возвращено строк: ${reversed}; в счёте осталось: ${kept} — уберите через кассу`
      : `снято; возвращено строк: ${reversed}`;
    db.prepare('UPDATE treatment_administrations SET stock_status = ?, stock_note = ? WHERE id = ?')
      .run('reversed', note.slice(0, 1000), administration.id);
  }

  return { reversal: { reversed, kept, lines: lines.length }, warnings };
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

  let extra = null;
  if (a.extra !== undefined && a.extra !== null && a.extra !== '') {
    extra = typeof a.extra === 'string' ? a.extra.slice(0, 2000) : JSON.stringify(a.extra).slice(0, 2000);
  }

  // MED_ADMIN_CHARGE_V1 — отметка, списание и начисление в ОДНОЙ транзакции.
  // Иначе бывало бы списанное без отметки (упали после склада) и отмеченное
  // без списания, причём молча.
  return db.transaction(() => {
    const existing = isPrn ? null : liveMark(db, order.id, date, slot);
    if (existing) {
      if (existing.status === status) {
        // Двойное нажатие на общем планшете: НИЧЕГО не создаём — ни отметки,
        // ни движения товара, ни строки счёта, — но отвечаем тем же, чем
        // ответили в первый раз, чтобы экран не решил, что списание не прошло.
        return {
          administration: existing, already: true,
          stock: { status: existing.stock_status || '', note: existing.stock_note || '', basis: null },
          charges: chargeSummary(db, existing.id),
          warnings: [],
        };
      }
      throw new RpcError('Отметка на этот час уже стоит. Снять её может старшая медсестра.', 400);
    }

    const at = nowUtc(db);
    const info = db.prepare(`INSERT INTO treatment_administrations
        (order_id, due_date, due_slot, status, given_at, given_by, reason, note, extra_consumption)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      order.id, date, slot, status, at, (user && user.id) || null,
      reason, str(a.note, 500), extra,
    );
    const administration = db.prepare('SELECT * FROM treatment_administrations WHERE id = ?')
      .get(info.lastInsertRowid);

    // Списывает и начисляет ТОЛЬКО «дала». Отказ, пропуск и задержка — это
    // невведённая доза: со склада ничего не ушло, платить не за что.
    const charge = status === 'given'
      ? chargeAdministration(db, order, administration, user)
      : { stock_status: '', stock_note: '', lines: [], warnings: [], basis: null };

    return {
      administration: db.prepare('SELECT * FROM treatment_administrations WHERE id = ?').get(administration.id),
      already: false,
      stock: { status: charge.stock_status, note: charge.stock_note, basis: charge.basis },
      charges: charge.lines,
      warnings: charge.warnings,
    };
  })();
}

// ─── 5. Снять отметку ───────────────────────────────────────────────────────

// ─── UNMARK_WINDOW_V1 — своя отметка, снятая по горячим следам ──────────────
//
// Решение владельца (2026-09-04): «медсестра может снять свою отметку в
// течение короткого времени, дальше — старшая». До этого дня снять могла
// ТОЛЬКО старшая, и цена ошибки на планшете была несоразмерна ей самой: на
// общем экране палец попадает в соседнюю строку, и чтобы убрать промах,
// сделанный секунду назад, приходилось искать по отделению человека с другой
// ролью. Это не строгость, а очередь — и она учит не исправлять промахи.
//
// Пятнадцать минут — не круглое число ради круглости: это тот же допуск, по
// которому расписание считает дозу «вовремя» (GRACE_MIN в
// domain/mar-schedule.js). Одна и та же смена, один и тот же порядок величин:
// пока доза ещё считается введённой вовремя, её отметку можно поправить самой.
// Константа своя, а не импорт: совпадение величин — это довод, а не связь, и
// сдвиг допуска расписания не должен молча переписывать чьи-то права.
//
// ЧЕГО ОКНО НЕ ДЕЛАЕТ: оно не отменяет ни причину, ни след. Быстрое
// исправление медсестры пишет voided_at / voided_by / void_reason ровно так же,
// как снятие старшей, и возвращает склад и деньги тем же путём. Смысл окна —
// СКОРОСТЬ, а не тишина: запись о том, что отметка была и её сняли, остаётся
// в истории болезни навсегда.
export const UNMARK_WINDOW_MIN = 15;

/**
 * Кому эта строка по силам — единственное место, где живёт правило.
 *
 * `nowMs` и `windowMin` — ПАРАМЕТРЫ, а не глобальные часы, и это ради теста:
 * проверить границу окна иначе можно было бы только сном на пятнадцать минут.
 * Часы сюда подаёт вызывающий, и подаёт их СЕРВЕРНЫЕ (nowUtc): окно — это
 * право, а право, посчитанное по часам браузера, снимается подстановкой
 * `now` в запрос. По той же причине treatment_tasks_due считает эту же
 * подсказку серверными часами, а не своим тестовым `now`.
 *
 * Возвращает `{ allowed: true, … }` либо `{ allowed: false, status, message }`,
 * а не бросает: тот же ответ нужен экрану медсестры, чтобы показать кнопку
 * там, где она сработает, и сказать словами, где не сработает.
 */
export function unmarkVerdict(row, user, nowMs, windowMin = UNMARK_WINDOW_MIN) {
  if (hasAnyRole(user, UNMARK_ANY_ROLES)) {
    return { allowed: true, scope: 'any', window_min: windowMin, left_min: null };
  }
  if (!hasAnyRole(user, UNMARK_ROLES)) {
    return { allowed: false, status: 403, scope: 'none',
             message: 'Снятие отметки — недоступно вашей роли.' };
  }

  // Чужую отметку не снимают вовсе — ни через минуту, ни через час.
  const mine = row && row.given_by != null && user && user.id != null
    && Number(row.given_by) === Number(user.id);
  if (!mine) {
    return { allowed: false, status: 403, scope: 'other',
             message: 'Снять можно только свою отметку, а эту записал другой человек. '
                    + 'Снимет старшая медсестра или администратор — позовите её.' };
  }

  const givenMs = Date.parse(row.given_at || '');
  const ageMin = Number.isFinite(givenMs) ? (Number(nowMs) - givenMs) / 60000 : Infinity;
  if (!(ageMin < windowMin)) {
    return { allowed: false, status: 403, scope: 'late', window_min: windowMin,
             message: `Свою отметку можно снять в течение ${windowMin} мин после записи — `
                    + 'это время вышло. Дальше снимает старшая медсестра или '
                    + 'администратор: позовите её.' };
  }

  return {
    allowed: true, scope: 'own', window_min: windowMin,
    left_min: Math.max(0, Math.ceil(windowMin - ageMin)),
  };
}

/**
 * Старшая медсестра и администратор — без ограничений; медсестра — свою
 * отметку и в пределах UNMARK_WINDOW_MIN (правило выше). Строка НЕ УДАЛЯЕТСЯ —
 * в этом отличие от референса, где снятая отметка исчезает бесследно и
 * разобраться, кто и что снял, уже невозможно. Здесь остаётся след: кто снял,
 * когда и почему; из действующих строку выводит voided_at, и слот снова
 * свободен для верной отметки.
 *
 * MED_ADMIN_CHARGE_V1 — снятие ВОЗВРАЩАЕТ и склад, и деньги: препарат идёт
 * обратно на остаток движением 'void', а строка начисления убирается. Двойное
 * снятие не возвращает дважды — на этот вопрос отвечает voided_at ниже, ещё до
 * всякой работы, а за ним стоит второй ответ: после первого снятия строк с
 * меткой этой отметки уже нет, и возвращать нечего.
 */
export function treatmentAdminUnmark(db, args, user) {
  requireRole(user, UNMARK_ROLES, 'Снятие отметки');
  const a = args || {};
  const id = posIntOrNull(a.administration_id);
  if (id === null) throw new RpcError('administration_id must be a positive integer.', 400);

  const reason = str(a.reason, 300);

  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM treatment_administrations WHERE id = ?').get(id);
    if (!row) throw new RpcError('Отметка не найдена.', 400);
    if (row.voided_at) {
      return {
        administration: row, already: true,
        reversal: { reversed: 0, kept: 0, lines: 0 }, warnings: [],
      };
    }

    // Часы — серверные (nowUtc), и другого источника у окна нет: `now` из
    // запроса открыл бы его кому угодно и насколько угодно.
    const verdict = unmarkVerdict(row, user, Date.parse(nowUtc(db)));
    if (!verdict.allowed) throw new RpcError(verdict.message, verdict.status || 403);

    // Причина обязательна ВСЕМ, включая быстрое исправление автора: снятая
    // отметка без причины — дыра в истории болезни, а не экономия движения.
    if (!reason) throw new RpcError('Снятие отметки без причины невозможно.', 400);

    const order = loadOrder(db, row.order_id);
    assertAdmissionAtLeast(db, order.admission_id, 'active');

    const at = nowUtc(db);
    db.prepare(`UPDATE treatment_administrations
                   SET voided_at = ?, voided_by = ?, void_reason = ?
                 WHERE id = ?`)
      .run(at, (user && user.id) || null, reason, row.id);

    const back = reverseAdministration(db, row, user);

    return {
      administration: db.prepare('SELECT * FROM treatment_administrations WHERE id = ?').get(row.id),
      already: false,
      reversal: back.reversal,
      warnings: back.warnings,
    };
  })();
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

  const groups = { overdue: [], now: [], later: [], prn: [], done: [] };

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

  // UNMARK_WINDOW_V1 — «Сделано за смену». Закрытая точка исчезает из четырёх
  // групп работы (её больше не надо делать), и до этого дня исчезала совсем:
  // отметить дозу последнему пациенту значило убрать его из списка — вместе с
  // единственной дорогой к исправлению промаха. Пятнадцатиминутное окно без
  // этого списка было бы правом без кнопки.
  //
  // Право считается ЗДЕСЬ и серверными часами, ровно тем же unmarkVerdict, что
  // стоит на самом снятии: экран не повторяет правило, он его показывает —
  // кнопку там, где она сработает, и текст отказа там, где нет.
  const nowSrv = Date.parse(nowUtc(db));
  for (const d of db.prepare(`
    SELECT a.*, o.kind, o.name, o.dose, o.route, o.source, o.freq_code, o.prn,
           o.service_id, o.stock_item_id,
           adm.id AS admission_id, adm.patient_id, adm.ward_id, adm.bed_id,
           p.full_name AS patient_name, w.name AS ward_name, b.code AS bed_code,
           u.full_name AS given_by_name
      FROM treatment_administrations a
      JOIN treatment_orders o ON o.id = a.order_id
      JOIN admissions adm ON adm.id = o.admission_id
      LEFT JOIN patients p ON p.id = adm.patient_id
      LEFT JOIN wards w ON w.id = adm.ward_id
      LEFT JOIN beds b ON b.id = adm.bed_id
      LEFT JOIN users u ON u.id = a.given_by
     WHERE a.due_date = ?
       AND a.voided_at IS NULL
       AND adm.status IN ('active','discharging')
       ${wardId === null ? '' : 'AND adm.ward_id = ?'}
     ORDER BY a.given_at DESC, a.id DESC`)
    .all(...(wardId === null ? [date] : [date, wardId]))) {
    groups.done.push({
      admission_id: d.admission_id, patient_id: d.patient_id, patient_name: d.patient_name,
      ward_id: d.ward_id, ward_name: d.ward_name, bed_id: d.bed_id, bed_code: d.bed_code,
      order_id: d.order_id, kind: d.kind, name: d.name, dose: d.dose, route: d.route,
      source: d.source, freq_code: d.freq_code, prn: d.prn,
      service_id: d.service_id, stock_item_id: d.stock_item_id,
      administration_id: d.id, status: d.status, reason: d.reason,
      date: d.due_date, slot: d.due_slot,
      given_at: d.given_at, given_by: d.given_by, given_by_name: d.given_by_name || '',
      stock_status: d.stock_status || '', stock_note: d.stock_note || '',
      undo: unmarkVerdict(d, user, nowSrv),
    });
  }

  // MED_ADMIN_CHARGE_V1 — сколько сегодняшних отметок остались НЕ СПИСАННЫМИ
  // по отделению. Это не задача медсестры (доза уже введена), а хвост для
  // старшей: разобрать и провести вручную. Считается там же, где смена, чтобы
  // счётчик было где показать.
  const issues = db.prepare(`
    SELECT COUNT(*) n
      FROM treatment_administrations a
      JOIN treatment_orders o ON o.id = a.order_id
      JOIN admissions adm ON adm.id = o.admission_id
     WHERE a.due_date = ?
       AND a.voided_at IS NULL
       AND a.stock_status IN (${STOCK_ISSUE.map(() => '?').join(',')})
       ${wardId === null ? '' : 'AND adm.ward_id = ?'}`)
    .get(...(wardId === null ? [date, ...STOCK_ISSUE] : [date, ...STOCK_ISSUE, wardId]));

  return {
    date,
    now: new Date(nowMs).toISOString(),
    ward_id: wardId,
    counts: {
      overdue: groups.overdue.length, now: groups.now.length,
      later: groups.later.length, prn: groups.prn.length,
      done: groups.done.length,
      stock_issues: Number(issues && issues.n) || 0,
    },
    groups,
  };
}
