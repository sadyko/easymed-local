// DOCS_FEED_V1 — лента готовых документов по всей клинике.
//
// Раздел «Документы» умел только одно: найти пациента и собрать бланк ему.
// Чтобы ответить на вопрос «что вообще готово за эту неделю», приходилось
// перебирать пациентов по одному. Здесь тот же материал развёрнут в список:
// каждая услуга, по которой есть результат или подписанный документ, — строка.
//
// ОДНА строка = ОДНА услуга (анализ, снимок, заключение), а не визит. Пациент
// с пятью анализами занимает пять строк — так фильтр по типу услуги вообще
// имеет смысл, а «Результаты анализов» отделяются от «Диагностики».
//
// Источников содержимого два, и они дополняют друг друга:
//   lab_results     — результаты анализов И диагностики (одна таблица на оба,
//                     см. service-workspace.js: «Labs + diagnostics use the
//                     same lab_results table»);
//   visit_documents — подписанные в кабинете заключения и загруженные файлы.
// Услуга попадает в ленту, если есть хотя бы одно из двух.
//
// Дата — ДЕНЬ ВИЗИТА, а не created_at строки результата: клиника ищет «что
// было в понедельник», а не «когда лаборант нажал сохранить».

import { canViewSection } from '../roles.js';
import { pageInt, searchArg } from './page-args.js';   // V3120_FINAL — числа и поиск из аргументов
import { localDate, localRangeWhere } from '../domain/day.js';
// LAB_ONE_CLINIC_V1 / BUILDING_REPORTS_V1 — граница «чьи это документы».
//
// У ленты не было фильтра ВООБЩЕ: она показывала документы всех зданий по
// случайности, а не по решению, и настройку doc_settings.lab_scope (миграция
// 085) не знала. Лента — это в первую очередь результаты анализов, то есть та
// же лабораторная поверхность, что очередь и «Готово»; клиника, запершая
// лабораторию в своём здании, обязана получить здесь то же самое, иначе
// граница, закрытая в одном списке, открыта в соседнем.
import {
  buildingContext, originExpr, summariseByBuilding, labScopeOf, labScopeWhere,
} from '../domain/buildings.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const SECTION = 'patient-documents';
const PAGE_MAX = 100;
const PAGE_DEFAULT = 20;

// Услуга считается «документом», если по ней есть результат или подписанная
// бумага. Один и тот же предикат нужен и списку, и счётчикам, поэтому он один.
const HAS_DOC = `(
     EXISTS (SELECT 1 FROM lab_results     lr WHERE lr.visit_service_id = vs.id)
  OR EXISTS (SELECT 1 FROM visit_documents vd WHERE vd.visit_service_id = vs.id)
)`;

const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

// Поиск по пациенту: локальный клиент не умеет .or(), но здесь мы пишем SQL
// сами, поэтому три колонки проверяются одним условием.
//
// lower_uni, а не lower: встроенный lower() в SQLite складывает регистр только
// у латиницы, и поиск «сабина» не находил «Сабина». Тот же UDF использует
// query-compiler для .ilike() (CYRILLIC_ILIKE_V1, db/connection.js).
function searchClause(q) {
  if (!q) return { sql: '', params: [] };
  const like = '%' + String(q).trim() + '%';
  return {
    // Название услуги ищется наравне с пациентом: «ОАК за эту неделю» —
    // такой же законный вопрос, как «документы Каримовой».
    sql: ` AND (lower_uni(p.full_name) LIKE lower_uni(?)`
       + ` OR lower_uni(COALESCE(p.mrn,'')) LIKE lower_uni(?)`
       + ` OR lower_uni(COALESCE(p.phone,'')) LIKE lower_uni(?)`
       + ` OR lower_uni(COALESCE(s.name,'')) LIKE lower_uni(?))`,
    params: [like, like, like, like],
  };
}

// V3120_PERF — «Всё время» больше не значит «вся история клиники».
//
// Пустой период (чип «Всё время») читал все визиты за все годы, и на трёхлетней
// клинике лента открывалась 15–21 с — всё это время база однопоточна и
// остальные экраны стоят. Теперь пустой период = последние DEFAULT_DAYS дней
// (и всё, что позже сегодняшнего дня — записи наперёд); ответ несёт `range`
// с флагом defaulted, чтобы экран мог это назвать. Явно выбранный период
// отдаётся как выбран, но не длиннее года (range.capped).
export const DEFAULT_DAYS = 90;
// Самый длинный период, который лента отдаёт за один запрос (год). Длиннее —
// начало периода подтягивается, и range.capped = true.
export const MAX_SPAN_DAYS = 366;

export function documentsFeed(db, args, user) {
  if (!canViewSection(db, user, SECTION)) {
    throw new RpcError('Раздел «Документы» вам не выдан.', 403);
  }
  const a = args || {};
  let from = ymd(a.from);
  const to = ymd(a.to);
  const q = searchArg(a.q);   // V3120_FINAL — не текст или длиннее 200 → 400, не 500
  const types = Array.isArray(a.types) ? a.types.filter((t) => typeof t === 'string' && t) : [];
  const limit = pageInt(a.limit, { def: PAGE_DEFAULT, min: 1, max: PAGE_MAX });   // V3120_FINAL
  const offset = pageInt(a.offset, { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });

  // Нижняя граница есть всегда: без неё запрос — вся история. И период не
  // длиннее MAX_SPAN_DAYS: каждый день периода — это строки, которые база
  // обязана перебрать, чтобы их сосчитать.
  let defaulted = false;
  let capped = false;
  if (!from) {
    defaulted = true;
    from = db.prepare("SELECT date(COALESCE(?, date('now','localtime')), ?) d")
      .get(to, `-${DEFAULT_DAYS - 1} days`).d;
  } else {
    const earliest = db.prepare("SELECT date(COALESCE(?, date('now','localtime')), ?) d")
      .get(to, `-${MAX_SPAN_DAYS - 1} days`).d;
    if (from < earliest) { from = earliest; capped = true; }
  }

  const ctx = buildingContext(db);
  const labScope = labScopeOf(db);
  const scopeSql = labScopeWhere(db, labScope, 'visit_services', 'vs');
  const origin = originExpr(db, 'visit_services', 'vs');
  const dayExpr = localDate('v.visit_date');

  // Период — по ДНЮ ВИЗИТА, через индекс idx_visits_date (day.js
  // localRangeWhere: грубый диапазон по индексу + точное сравнение местной
  // даты — та же выборка, что inLocalRange, при любом формате visit_date).
  // CROSS JOIN закрепляет порядок: сначала визиты периода, потом их строки.
  const search = searchClause(q);
  const baseOf = (f, t) => {
    const range = localRangeWhere('v.visit_date', f, t);
    return {
      sql: `
      FROM visits v
      CROSS JOIN visit_services vs ON vs.visit_id = v.id
      LEFT JOIN patients p ON p.id = v.patient_id
      LEFT JOIN services s ON s.id = vs.service_id
     WHERE ${range.sql} AND ${HAS_DOC}${scopeSql}${search.sql}`,
      params: range.params.concat(search.params),
    };
  };
  const base = baseOf(from, to);

  // ОДИН проход считает всё: разрез (тип × здание × день) складывается в
  // счётчики по типам (без фильтра по типу — иначе, выбрав «Лаборатория»,
  // сотрудник увидел бы нули у всех остальных), в итог (с фильтром), в разрез
  // по зданиям (без фильтра) и в число строк по дням — по нему страница ниже
  // находит СВОИ дни и не сортирует весь период. Раньше это были четыре
  // полных прохода.
  const cells = db.prepare(
    `SELECT COALESCE(s.type,'other') AS t, ${origin} AS origin, ${dayExpr} AS d, COUNT(*) AS n ${base.sql}
      GROUP BY t, origin, d`).all(...base.params);
  const typeCount = new Map();
  const originCount = new Map();
  const dayCount = new Map();            // только строки, прошедшие фильтр по типу
  let total = 0;
  const typeSet = new Set(types);
  for (const c of cells) {
    typeCount.set(c.t, (typeCount.get(c.t) || 0) + c.n);
    originCount.set(c.origin, (originCount.get(c.origin) || 0) + c.n);
    if (!typeSet.size || typeSet.has(c.t)) {
      total += c.n;
      dayCount.set(c.d, (dayCount.get(c.d) || 0) + c.n);
    }
  }
  // Порядок — как у прежнего GROUP BY t (двоичное сравнение строк).
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const byType = [...typeCount].sort((x, y) => cmp(x[0], y[0])).map(([t, c]) => ({ t, c }));

  const typeWhere = types.length
    ? ` AND COALESCE(s.type,'other') IN (${types.map(() => '?').join(',')})`
    : '';

  // Страница. Порядок ленты — местный день по убыванию, внутри дня vs.id по
  // убыванию, поэтому строки позиций [offset, offset+limit) лежат в
  // непрерывной полосе дней, которую видно по dayCount. Запрос идёт только по
  // этой полосе (те же условия, тот же порядок, сдвиг — внутри полосы) и
  // возвращает только ключи; поля и подзапросы — ниже, для ≤ PAGE_MAX строк.
  let pageIds = [];
  const days = [...dayCount.keys()].sort((x, y) => cmp(y, x));
  let before = 0;
  let firstDay = null;
  let lastDay = null;
  let skip = 0;
  for (const d of days) {
    const n = dayCount.get(d);
    if (before + n <= offset) { before += n; continue; }
    if (firstDay == null) { firstDay = d; skip = offset - before; }
    lastDay = d;
    before += n;
    if (before >= offset + limit) break;
  }
  if (firstDay != null) {
    const band = baseOf(lastDay, firstDay);
    pageIds = db.prepare(`
    SELECT vs.id AS id ${band.sql}${typeWhere}
     ORDER BY ${dayExpr} DESC, vs.id DESC
     LIMIT ? OFFSET ?`).all(...band.params, ...types, limit, skip).map((r) => r.id);
  }

  let rows = [];
  if (pageIds.length) {
    const detail = db.prepare(`
    SELECT vs.id            AS visit_service_id,
           vs.visit_id      AS visit_id,
           vs.status        AS status,
           vs.verified_at   AS verified_at,
           v.visit_date     AS visit_date,
           v.patient_id     AS patient_id,
           p.full_name      AS patient_name,
           p.mrn            AS mrn,
           s.name           AS service_name,
           COALESCE(s.type,'other') AS service_type,
           (SELECT COUNT(*) FROM lab_results lr WHERE lr.visit_service_id = vs.id)     AS result_count,
           (SELECT vd.doc_type FROM visit_documents vd WHERE vd.visit_service_id = vs.id
             ORDER BY vd.created_at DESC LIMIT 1)                                      AS doc_type,
           -- BUILDING_REPORTS_V1 — из какого здания документ. Строка приходит
           -- в список рядом с чужими, и без подписи регистратура не знает, к
           -- кому идти за бумагой.
           ${origin}                                                                   AS origin
      FROM visit_services vs
      JOIN visits   v ON v.id = vs.visit_id
      LEFT JOIN patients p ON p.id = v.patient_id
      LEFT JOIN services s ON s.id = vs.service_id
     WHERE vs.id IN (${pageIds.map(() => '?').join(',')})`).all(...pageIds);
    const byId = new Map(detail.map((r) => [r.visit_service_id, r]));
    rows = pageIds.map((id) => byId.get(id));
  }

  // DOCS_FEED_ANSWERS_V1 — регистратура читает ОТВЕТЫ прямо в строке, не
  // открывая архив пациента. Значения — только для строк текущей страницы
  // (≤ PAGE_MAX), одним батчем, а не подзапросом на строку.
  //
  // «Последний ввод показателя побеждает» — ровно то же правило (и тот же ключ
  // услуга\0параметр), что у LAB_DOC_ALL_ANALYTES_V1 в patient-documents.js:
  // повторный ввод того же показателя заменяет строку, но РАЗНЫЕ показатели
  // панели живут все. Порядок — по id, как вводил лаборант.
  const pageVsIds = rows.map((r) => r.visit_service_id);
  if (pageVsIds.length) {
    const lr = db.prepare(
      `SELECT id, visit_service_id, parameter, value, unit, flag
         FROM lab_results WHERE visit_service_id IN (${pageVsIds.map(() => '?').join(',')})`
    ).all(...pageVsIds);
    const latest = new Map();
    for (const r of lr) {
      const key = r.visit_service_id + '\0' + (r.parameter || '');
      const prev = latest.get(key);
      if (!prev || r.id > prev.id) latest.set(key, r);
    }
    const byVs = new Map();
    for (const r of [...latest.values()].sort((a, b) => a.id - b.id)) {
      if (!byVs.has(r.visit_service_id)) byVs.set(r.visit_service_id, []);
      byVs.get(r.visit_service_id).push({
        parameter: r.parameter || '',
        value: r.value == null ? '' : String(r.value),
        unit: r.unit || '',
        flag: r.flag || '',
      });
    }
    for (const row of rows) row.results = byVs.get(row.visit_service_id) || [];
  }
  for (const row of rows) row.building = ctx.label(row.origin);

  return {
    rows,
    total,
    // Сколько уже отдано — клиенту не надо складывать самому, а «Показать
    // ещё» должна знать, есть ли что показывать.
    has_more: offset + rows.length < total,
    next_offset: offset + rows.length,
    by_type: byType,
    // Разрез по зданиям считается по ТОЙ ЖЕ выборке (без постраничного среза и
    // без фильтра по типу — как и счётчики выше).
    //
    // СКЛАДЫВАЕТ БАЗА, А НЕ JS. Здесь третий раз за страницу шёл ПОЛНЫЙ скан
    // ленты — все строки поднимались в память только затем, чтобы разложить их
    // по двум-трём корзинам и выбросить; у клиники с десятками тысяч
    // результатов это десятки тысяч объектов на КАЖДОЕ «Показать ещё». GROUP BY
    // отдаёт ровно столько строк, сколько зданий.
    //
    // Форма ответа не изменилась: `rows` в разрезе означает «сколько строк
    // легло в корзину», и теперь это число приходит из COUNT(*).
    //
    // V3120_PERF — корзины берутся из того же единственного прохода (cells).
    by_building: summariseByBuilding(
      ctx,
      [...originCount].map(([o, n]) => ({ origin: o, n })),
      { n: (r) => r.n },
    ).map(({ n, ...b }) => ({ ...b, rows: n })),
    lab_scope: labScope,
    // Какой период на самом деле отдан. defaulted = клиент период не задал
    // («Всё время»), и сервер взял последние DEFAULT_DAYS дней; capped =
    // заданный период длиннее MAX_SPAN_DAYS, и его начало подтянуто.
    range: { from, to: to || null, defaulted, capped, default_days: DEFAULT_DAYS, max_days: MAX_SPAN_DAYS },
  };
}
