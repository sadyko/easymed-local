// BUILDING_REPORTS_V1 — одно определение «в каком ЗДАНИИ это произошло».
//
// Правило то же, что у day.js про время и money.js про долг: ни один отчёт не
// пишет себе фильтр по зданию сам, он приходит сюда. Раньше каждый писал —
// и каждый писал ОДНО И ТО ЖЕ НЕ ТО: `branch_id`, то есть филиал внутри своей
// базы. Соседнее здание — это отдельная база, соединённая branch-sync'ом, и его
// строки помечены `sync_origin` (миграция 083): NULL — заведено здесь, буква —
// приехало оттуда. Фильтр по branch_id у приехавшей строки не совпадает ни с
// чем (branch_id не путешествует и приезжает пустым), поэтому все денежные
// отчёты по чужому зданию отдавали ПУСТО, а счётчики без фильтра — наоборот,
// молча складывали два здания в одно число.
//
// Логика «какие здания есть» лежит в общем с браузером чистом модуле
// public/js/admin/views/report-buildings.js — тот же приём, что у lab-stats.js,
// берущего LAB_NAME_RE из views/lab-service.js. Здесь — только SQL и подписи.
//
// НАЛИЧИЕ МЕТКИ ВЫЯСНЯЕТСЯ У БАЗЫ, А НЕ ПРЕДПОЛАГАЕТСЯ. Метка есть не у всех
// таблиц: у patients/visits/visit_services/lab_results — с миграции 083, у
// invoices/invoice_items/payments — только с 087, а у stock_movements,
// cash_movements и cash_shifts её нет и не будет (склад и касса между зданиями
// не ездят). Запрос со ссылкой на несуществующую колонку не вернул бы нули —
// он бы УПАЛ, и отчёты перестали бы открываться вовсе. Отсутствие колонки
// означает ровно то, что и есть на самом деле: у этой таблицы все строки свои.

import {
  buildingOptions, normalizeLetter, ownKeyOf, coversAll, OWN_KEY,
} from '../../../public/js/admin/views/report-buildings.js';
// LAB_ONE_CLINIC_V1 — границу лаборатории задаёт ОДНА функция, общая с экраном
// (views/lab-scope.js). Импортируем правило, а не переписываем его: сводка,
// статистика лаборатории, лента документов и очередь обязаны одинаково
// отвечать на вопрос «чьи это пробирки».
import { normalizeLabScope, ownBuildingOnly } from '../../../public/js/admin/views/lab-scope.js';

export { OWN_KEY, ownBuildingOnly };

// Таблицы, у которых метка происхождения есть уже сейчас (083) или появится
// вместе с переездом денег. Список нужен, чтобы собрать буквы, реально
// встреченные в данных.
const ORIGIN_TABLES = ['invoices', 'payments', 'visit_services', 'visits', 'patients', 'lab_results'];

// PRAGMA на каждый вызов — это десятки лишних запросов на отчёт, поэтому ответ
// кэшируется на объекте соединения. WeakMap, а не Map: тесты открывают сотни
// баз в памяти, и обычная карта держала бы их все.
const columnCache = new WeakMap();

/** Есть ли у таблицы такая колонка (и существует ли сама таблица). */
export function hasColumn(db, table, col) {
  let byTable = columnCache.get(db);
  if (!byTable) { byTable = new Map(); columnCache.set(db, byTable); }
  let cols = byTable.get(table);
  if (!cols) {
    cols = new Set();
    try {
      for (const r of db.prepare(`PRAGMA table_info(${table})`).all()) cols.add(r.name);
    } catch (_) { /* нет таблицы — пустой набор */ }
    byTable.set(table, cols);
  }
  return cols.has(col);
}

/**
 * Настройка «кого обслуживает лаборатория» (doc_settings.lab_scope, мигр. 085).
 * ОДНО место, где серверные лабораторные поверхности её читают: плитка сводки,
 * статистика и лента документов иначе разошлись бы с очередью — а это ровно то
 * расхождение, которое уже один раз случилось (см. dashboard.js).
 */
export function labScopeOf(db) {
  if (!hasColumn(db, 'doc_settings', 'lab_scope')) return normalizeLabScope(null);
  try {
    const r = db.prepare('SELECT lab_scope FROM doc_settings WHERE id = 1').get();
    return normalizeLabScope(r && r.lab_scope);
  } catch (_) { return normalizeLabScope(null); }
}

/**
 * SQL-фрагмент границы лаборатории для WHERE: своё здание или вся клиника.
 * Ровно то же решение, что scopeQuery() принимает для запроса браузера.
 */
export function labScopeWhere(db, scope, table, alias) {
  if (!ownBuildingOnly(scope)) return '';
  if (!hasColumn(db, table, 'sync_origin')) return '';
  return ` AND ${alias}.sync_origin IS NULL`;
}

/** Буква ЭТОЙ установки. */
export function ownBuildingLetter(db) {
  if (!hasColumn(db, 'branch_identity', 'letter')) return null;
  try {
    const r = db.prepare('SELECT letter FROM branch_identity WHERE id = 1').get();
    return normalizeLetter(r && r.letter);
  } catch (_) { return null; }
}

/**
 * SQL-выражение «ключ здания этой строки»: '' для своей, буква для приехавшей.
 * Пустая строка, а не NULL, чтобы GROUP BY складывал свои строки в одну
 * корзину, а не в NULL-группу, которую потом надо помнить отдельно.
 */
export function originExpr(db, table, alias) {
  return hasColumn(db, table, 'sync_origin') ? `COALESCE(${alias}.sync_origin, '')` : `''`;
}

// Буквы, реально встреченные в данных. Здание, приславшее записи, обязано быть
// названо, даже если его строки нет в перечне branches.
function seenLetters(db) {
  const out = new Set();
  for (const t of ORIGIN_TABLES) {
    if (!hasColumn(db, t, 'sync_origin')) continue;
    try {
      for (const r of db.prepare(`SELECT DISTINCT sync_origin AS s FROM ${t} WHERE sync_origin IS NOT NULL`).all()) {
        const l = normalizeLetter(r.s);
        if (l) out.add(l);
      }
    } catch (_) { /* таблицы может не быть */ }
  }
  return [...out];
}

/**
 * Контекст зданий: перечень, свой ключ и подписи.
 *
 * Подпись своего здания — ЕГО СОБСТВЕННОЕ ИМЯ из перечня (у главной клиники
 * это её название), а не «Филиал A»: владелец не называет свою клинику
 * филиалом. Незнакомая буква подписывается «Филиал X» — той же формулировкой,
 * что метки в списках (patient-card.js, laboratory.js, «Филиал {letter}»).
 */
export function buildingContext(db) {
  const ownLetter = ownBuildingLetter(db);
  let branches = [];
  if (hasColumn(db, 'branches', 'letter')) {
    // БЕЗ `WHERE active = 1` — и это весь смысл: соседнее здание заводится
    // именно как active = 0 (branch-sync/catalogue.js).
    try { branches = db.prepare('SELECT name, letter FROM branches WHERE letter IS NOT NULL').all(); }
    catch (_) { branches = []; }
  }
  const options = buildingOptions({ branches, ownLetter, seen: seenLetters(db) });
  const ownKey = ownKeyOf(options);
  const byKey = new Map(options.map((o) => [o.key, o]));

  const label = (key) => {
    const k = key === '' || key == null ? ownKey : key;
    const opt = byKey.get(k);
    if (opt && opt.name) return opt.name;
    if (k === OWN_KEY) return 'Это здание';
    return 'Филиал ' + k;
  };

  return {
    ownLetter,
    ownKey,
    options,
    /** Ключ здания по значению sync_origin ('' / NULL = своё). */
    keyOf: (origin) => (origin === '' || origin == null ? ownKey : (normalizeLetter(origin) || String(origin))),
    label,
    /** Подпись для отчётов, где строку нельзя привязать к сотруднику. */
    unattributed: (key) => label(key) + ', врач не указан',
  };
}

/**
 * Фильтр по зданиям для WHERE. Пустой/отсутствующий список и «выбраны все» =
 * фильтра нет (та же семантика, что у branch_ids: «ничего не выбрано» не
 * означает «ничего не показывать»).
 *
 * @returns {{clause: string, params: Array}}
 */
export function buildingWhere(db, ctx, args, table, alias) {
  const req = args && Array.isArray(args.buildings) ? args.buildings : null;
  if (!req || req.length === 0) return { clause: '', params: [] };

  const keys = new Set();
  for (const k of req) {
    const l = normalizeLetter(k);
    if (l) keys.add(l);
    else if (k === OWN_KEY) keys.add(OWN_KEY);
  }
  if (keys.size === 0) return { clause: '', params: [] };
  if (coversAll([...keys], ctx.options)) return { clause: '', params: [] };

  const wantOwn = keys.has(ctx.ownKey);
  const foreign = [...keys].filter((k) => k !== ctx.ownKey);

  // Таблица без метки: все её строки — свои. «Только соседнее здание» обязано
  // вернуть ПУСТО, а не всё подряд.
  if (!hasColumn(db, table, 'sync_origin')) {
    return wantOwn ? { clause: '', params: [] } : { clause: ' AND 1 = 0', params: [] };
  }

  const col = `${alias}.sync_origin`;
  const parts = [];
  if (wantOwn) parts.push(`${col} IS NULL`);
  if (foreign.length) parts.push(`${col} IN (${foreign.map(() => '?').join(',')})`);
  if (!parts.length) return { clause: ' AND 1 = 0', params: [] };
  return { clause: ` AND (${parts.join(' OR ')})`, params: foreign };
}

/**
 * Свести строки в разрез по зданиям. Возвращает по строке на КАЖДОЕ известное
 * здание — включая то, где за период ничего не было: ноль напротив здания и
 * отсутствие здания в списке читаются по-разному, и второе выглядит как потеря
 * данных.
 *
 * @param {object} ctx контекст зданий
 * @param {Array} rows строки с полем origin
 * @param {Record<string, (row: object) => number>} metrics что складывать
 */
export function summariseByBuilding(ctx, rows, metrics = {}) {
  const names = Object.keys(metrics);
  const blank = (key, own) => {
    const b = { key, label: ctx.label(key), own, rows: 0 };
    for (const n of names) b[n] = 0;
    return b;
  };
  const acc = new Map();
  for (const o of ctx.options) acc.set(o.key, blank(o.key, o.own));
  for (const r of rows) {
    const key = ctx.keyOf(r.origin);
    if (!acc.has(key)) acc.set(key, blank(key, false));
    const bucket = acc.get(key);
    bucket.rows += 1;
    for (const n of names) bucket[n] += Number(metrics[n](r)) || 0;
  }
  for (const b of acc.values()) for (const n of names) b[n] = Math.round(b[n] * 100) / 100;
  return [...acc.values()].sort((a, b) => (a.own === b.own ? (a.key < b.key ? -1 : 1) : (a.own ? -1 : 1)));
}
