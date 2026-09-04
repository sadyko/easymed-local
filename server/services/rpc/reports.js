// Reporting RPCs — read-only. /api/db can't do SUM/GROUP BY/date-range
// filters on most tables, so both the period-overview KPIs and the tabular
// date-range reports are computed here from raw rows. Any authenticated
// user may call these (requireAuth is applied by the route; no extra role
// gate needed — see server/routes/rpc.js).

import { today, localDate, localMonth, inLocalRange } from '../domain/day.js';
import { outstandingWhere } from '../domain/money.js';
// BUILDING_REPORTS_V1 — «в каком ЗДАНИИ это произошло». Отдельное измерение от
// branch_id: см. шапку domain/buildings.js.
import {
  buildingContext, buildingWhere, originExpr, summariseByBuilding, hasColumn,
  normalizeLetter, stampLetter,
} from '../domain/buildings.js';
// INVOICE_METHOD_COLUMN_V1 — словарь способов оплаты общий с браузером. Тот же
// приём, что в services/telegram/render.js, который берёт оттуда doc-render.js:
// модуль чистый (без DOM и без node-встроенных), поэтому грузится в обоих.
import { formatMethods } from '../../../public/js/shared/payment-methods.js';
import { INFLOW_SQL } from '../../../public/js/shared/payment-methods.js';   // DEPOSIT_REVENUE_V1

export class RpcError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Accepts a 'YYYY-MM-DD'-ish string (also tolerates a full timestamp, since
// only the date portion is ever used in a date(col) BETWEEN comparison).
// Anything else is rejected so a bad range never silently matches nothing
// (or everything).
function isDateish(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
}

function resolveRange(db, args) {
  const t = today(db);
  const from = args && args.from !== undefined && args.from !== null && args.from !== '' ? args.from : t;
  const to = args && args.to !== undefined && args.to !== null && args.to !== '' ? args.to : t;
  if (!isDateish(from)) {
    throw new RpcError('from must be a YYYY-MM-DD date.', 400);
  }
  if (!isDateish(to)) {
    throw new RpcError('to must be a YYYY-MM-DD date.', 400);
  }
  return { from, to };
}

// BUILDING_REPORTS_V1 — сводка за период ПО ЗДАНИЯМ.
//
// До этого у неё не было НИ ОДНОГО фильтра, и это давало обе ошибки сразу:
// «Новых пациентов» и «Визитов» молча складывали своё здание с приехавшими
// строками (числа завышены и ни с чем на экране не сходились), а деньги
// приехать не могли вовсе — значит, выручка соседнего здания в сводке просто
// отсутствовала. Теперь каждая цифра считается ПО ЗДАНИЯМ, наверх отдаётся
// итог по клинике, а рядом — разрез, где видно, чей это вклад.
export function reportsOverview(db, args, _user) {
  const { from, to } = resolveRange(db, args);
  const ctx = buildingContext(db);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const bw = (table, alias) => buildingWhere(db, ctx, args, table, alias);

  const pf = bw('payments', 'p');
  const cash = all(
    // DEPOSIT_REVENUE_V1 — платежи «кошельком» уже посчитаны выручкой в день
    // приёма депозита; второй раз их считать нельзя.
    `SELECT ${originExpr(db, 'payments', 'p')} AS origin, COALESCE(SUM(p.amount),0) s
       FROM payments p WHERE ${INFLOW_SQL} AND ${inLocalRange('p.paid_at')}${pf.clause}
      GROUP BY origin`,
    from, to, ...pf.params
  );
  const inf = bw('invoices', 'i');
  const invoicesCreated = all(
    `SELECT ${originExpr(db, 'invoices', 'i')} AS origin, COUNT(*) n
       FROM invoices i WHERE ${inLocalRange('i.created_at')}${inf.clause}
      GROUP BY origin`,
    from, to, ...inf.params
  );
  const ptf = bw('patients', 'pt');
  const patientsNew = all(
    `SELECT ${originExpr(db, 'patients', 'pt')} AS origin, COUNT(*) n
       FROM patients pt WHERE ${inLocalRange('pt.created_at')}${ptf.clause}
      GROUP BY origin`,
    from, to, ...ptf.params
  );
  const vf = bw('visits', 'v');
  const visits = all(
    `SELECT ${originExpr(db, 'visits', 'v')} AS origin, COUNT(*) n
       FROM visits v WHERE ${inLocalRange('v.visit_date')}${vf.clause}
      GROUP BY origin`,
    from, to, ...vf.params
  );
  // All-time (not range-limited): what's currently owed across all open invoices.
  const outf = bw('invoices', 'i');
  const outstanding = all(
    `SELECT ${originExpr(db, 'invoices', 'i')} AS origin,
            COALESCE(SUM(i.total_amount - i.paid_amount),0) s
       FROM invoices i WHERE ${outstandingWhere('i.status')}${outf.clause}
      GROUP BY origin`,
    ...outf.params
  );

  // Один разрез на все пять метрик: строки разных запросов сводятся по ключу
  // здания, а не печатаются пятью отдельными списками.
  const merged = [
    ...cash.map((r) => ({ origin: r.origin, cash_collected: r.s })),
    ...invoicesCreated.map((r) => ({ origin: r.origin, invoices_created: r.n })),
    ...patientsNew.map((r) => ({ origin: r.origin, patients_new: r.n })),
    ...visits.map((r) => ({ origin: r.origin, visits_count: r.n })),
    ...outstanding.map((r) => ({ origin: r.origin, outstanding_total: r.s })),
  ];
  const buildings = summariseByBuilding(ctx, merged, {
    cash_collected:   (r) => r.cash_collected || 0,
    invoices_created: (r) => r.invoices_created || 0,
    patients_new:     (r) => r.patients_new || 0,
    visits_count:     (r) => r.visits_count || 0,
    outstanding_total:(r) => r.outstanding_total || 0,
  }).map((b) => { const { rows: _rows, ...rest } = b; return rest; });

  const sum = (k) => buildings.reduce((n, b) => n + b[k], 0);
  return {
    cash_collected: round2(sum('cash_collected')),
    invoices_created: sum('invoices_created'),
    patients_new: sum('patients_new'),
    visits_count: sum('visits_count'),
    outstanding_total: round2(sum('outstanding_total')),
    // Разрез по зданиям + сколько их всего: экран, где зданий больше одного,
    // обязан сказать это словами, а не показать одно число на два дома.
    buildings,
    building_count: buildings.length,
    from,
    to,
  };
}

// BUILDING_REPORTS_V1 — у каждого «сырого» отчёта тоже появляется здание.
// Запрос строится ПО БАЗЕ, а не константой: метка происхождения есть не у всех
// таблиц (у payments/invoices она появляется вместе с переездом денег), и
// ссылка на несуществующую колонку не вернула бы нули — она уронила бы отчёт.
// `origin` в выборке служебный: в строку его подставляет runReport подписью.
function legacyReports(db) {
  return {
  payments: {
    columns: ['Date', 'Patient', 'Invoice', 'Amount', 'Method', 'Cashier'],
    table: 'payments', alias: 'p',
    sql: (bf) => `
      SELECT ${localDate('p.paid_at')} AS date,
             pt.full_name           AS patient,
             i.invoice_number       AS invoice,
             p.amount                AS amount,
             p.method                AS method,
             u.full_name             AS cashier,
             ${originExpr(db, 'payments', 'p')} AS origin
        FROM payments p
        JOIN invoices i ON i.id = p.invoice_id
        JOIN patients pt ON pt.id = i.patient_id
        LEFT JOIN users u ON u.id = p.cashier_id
       WHERE ${inLocalRange('p.paid_at')}${bf.clause}
       ORDER BY p.paid_at
    `,
    row: (r) => [r.date, r.patient, r.invoice, round2(r.amount), r.method, r.cashier || ''],
  },
  invoices: {
    columns: ['Invoice #', 'Date', 'Patient', 'Total', 'Paid', 'Balance', 'Status'],
    table: 'invoices', alias: 'i',
    sql: (bf) => `
      SELECT i.invoice_number AS invoice_number,
             ${localDate('i.created_at')} AS date,
             pt.full_name AS patient,
             i.total_amount AS total,
             i.paid_amount AS paid,
             (i.total_amount - i.paid_amount) AS balance,
             i.status AS status,
             ${originExpr(db, 'invoices', 'i')} AS origin
        FROM invoices i
        JOIN patients pt ON pt.id = i.patient_id
       WHERE ${inLocalRange('i.created_at')}${bf.clause}
       ORDER BY i.created_at
    `,
    row: (r) => [r.invoice_number, r.date, r.patient, round2(r.total), round2(r.paid), round2(r.balance), r.status],
  },
  services: {
    columns: ['Service', 'Qty', 'Revenue'],
    table: 'invoices', alias: 'i',
    sql: (bf) => `
      SELECT s.name AS service,
             SUM(ii.quantity) AS qty,
             SUM(ii.total) AS revenue,
             ${originExpr(db, 'invoices', 'i')} AS origin
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        JOIN services s ON s.id = ii.service_id
       WHERE ${inLocalRange('i.created_at')}${bf.clause}
       GROUP BY origin, s.id, s.name
       ORDER BY revenue DESC
    `,
    row: (r) => [r.service, r.qty, round2(r.revenue)],
  },
  visits: {
    columns: ['Date', 'Patient', 'Doctor', 'Type', 'Status'],
    table: 'visits', alias: 'v',
    sql: (bf) => `
      SELECT ${localDate('v.visit_date')} AS date,
             pt.full_name AS patient,
             u.full_name AS doctor,
             v.visit_type AS type,
             v.status AS status,
             ${originExpr(db, 'visits', 'v')} AS origin
        FROM visits v
        JOIN patients pt ON pt.id = v.patient_id
        LEFT JOIN users u ON u.id = v.doctor_id
       WHERE ${inLocalRange('v.visit_date')}${bf.clause}
       ORDER BY v.visit_date
    `,
    row: (r) => [r.date, r.patient, r.doctor || '', r.type, r.status],
  },
  patients: {
    columns: ['MRN', 'Name', 'Gender', 'Registered'],
    table: 'patients', alias: 'pt',
    sql: (bf) => `
      SELECT pt.mrn AS mrn, pt.full_name AS full_name, pt.gender AS gender,
             ${localDate('pt.created_at')} AS registered,
             ${originExpr(db, 'patients', 'pt')} AS origin
        FROM patients pt
       WHERE ${inLocalRange('pt.created_at')}${bf.clause}
       ORDER BY pt.created_at
    `,
    row: (r) => [r.mrn, r.full_name, r.gender, r.registered],
  },
  stock_movements: {
    columns: ['Date', 'Product', 'Type', 'Qty', 'Unit cost'],
    // Складские движения между зданиями НЕ ездят — своя строка у каждого.
    table: 'stock_movements', alias: 'sm',
    sql: (bf) => `
      SELECT ${localDate('sm.created_at')} AS date,
             pr.name AS product,
             sm.kind AS kind,
             sm.qty AS qty,
             sm.unit_cost AS unit_cost,
             sm.id AS id,
             ${originExpr(db, 'stock_movements', 'sm')} AS origin
        FROM stock_movements sm
        JOIN products pr ON pr.id = sm.product_id
       WHERE ${inLocalRange('sm.created_at')}${bf.clause}
       ORDER BY sm.id DESC
    `,
    row: (r) => [r.date, r.product, r.kind, r.qty, r.unit_cost == null ? null : round2(r.unit_cost)],
  },
  };
}

// ---------------------------------------------------------------------------
// REPORTS_HUB_RU_V1 — the seven report kinds behind the card-grid Reports page
// (mirrors production easymed's Reports hub). Each takes {from, to, branch_ids}
// where branch_ids is a PROPER-subset filter: empty/absent = all branches,
// including rows whose branch_id is NULL (same semantics as production).
// ---------------------------------------------------------------------------

// Validated branch filter → { clause: ' AND col IN (?,?)', params: [...] }.
function branchFilter(args, col) {
  const ids = args && args.branch_ids;
  if (!Array.isArray(ids) || ids.length === 0) return { clause: '', params: [] };
  const clean = ids.map(Number).filter(Number.isInteger);
  if (clean.length === 0) return { clause: '', params: [] };
  return { clause: ` AND ${col} IN (${clean.map(() => '?').join(',')})`, params: clean };
}

const INV_STATUS_RU = {
  unpaid: 'Не оплачен', partial: 'Частично', paid: 'Оплачен',
  refunded: 'Возврат', void: 'Отменён', debt: 'Долг',
};

// One de-duplicated doctor/rate per invoice item: a single visit_service per
// item, and the best active rate per (doctor, service) — plain LEFT JOINs on
// doctor_rates could multiply rows when duplicates exist.
const ITEM_DOCTOR_JOIN = `
  LEFT JOIN (SELECT invoice_item_id, MIN(doctor_id) AS doctor_id
               FROM visit_services
              WHERE invoice_item_id IS NOT NULL AND doctor_id IS NOT NULL
              GROUP BY invoice_item_id) vs ON vs.invoice_item_id = ii.id
  LEFT JOIN users doc ON doc.id = vs.doctor_id
  LEFT JOIN (SELECT doctor_id, service_id, MAX(percent) AS percent, MAX(fix) AS fix FROM (
               SELECT doctor_id, service_id, percent, NULL AS fix
                 FROM doctor_rates WHERE active = 1
               UNION ALL
               -- DOC_RATE_JSON_V1 — ставки из карточки сотрудника («Услуги и
               -- ставки», users.service_rates: service_id, pct, fix?, branches).
               -- Ветка branches пока не сужает выборку (одна клиника).
               -- DOCTOR_FIX_RATE_V1 — fix: фиксированная сумма за единицу
               -- услуги; когда она задана, процент к строке не применяется.
               SELECT u.id AS doctor_id,
                      CAST(json_extract(j.value, '$.service_id') AS INTEGER) AS service_id,
                      CAST(json_extract(j.value, '$.pct') AS REAL) AS percent,
                      CAST(json_extract(j.value, '$.fix') AS REAL) AS fix
                 FROM users u, json_each(u.service_rates) j
                WHERE u.service_rates IS NOT NULL AND u.service_rates != ''
                  AND json_valid(u.service_rates)
             ) GROUP BY doctor_id, service_id) dr
         ON dr.doctor_id = vs.doctor_id AND dr.service_id = ii.service_id
`;

// DOC_RATE_JSON_V1 — процент строки: персональная ставка за услугу (таблица или
// JSON карточки), иначе ставка по умолчанию из карточки (service_rate_default).
const ITEM_PCT_SQL = `COALESCE(dr.percent, doc.service_rate_default, 0)`;

// DOCTOR_FIX_RATE_V1 — фиксированная ставка врача за единицу услуги (NULL, если
// врач получает процент). Только из карточки: в таблице doctor_rates фикса нет.
const ITEM_FIX_SQL = `dr.fix`;

// Invoice-level discount prorated onto this item (items carry no own discount).
const ITEM_DISCOUNT_SQL = `CASE WHEN i.subtotal > 0
  THEN i.discount_amount * ii.total / i.subtotal ELSE 0 END`;

// DOCTOR_SHARE_AFTER_TAX_V1 — ЕДИНЫЙ порядок расчёта доли врача:
//
//     база   = сумма строки − скидка (доля скидки счёта на эту строку)
//     налог  = база × ставка налога услуги (у клиники это 6%)
//     доля   = (база − налог) × процент врача
//
// Врач получает процент от того, что осталось у клиники ПОСЛЕ налога, а не от
// оборота: раньше процент брался с базы ДО налога, и на 6% налога врачу
// переплачивалось 6% его доли с каждой строки. Отчёт «Общая выручка» при этом
// печатал колонку «Налог» рядом — то есть сам показывал базу, из которой доля
// НЕ вычиталась.
//
// Ставку налога берём подзапросом, а не через алиас s: services джойнится не во
// всех отчётах (в doctor_salaries его нет), и ссылка на s.tax_rate там уронила
// бы запрос.
const ITEM_TAX_RATE_SQL = `COALESCE((SELECT sx.tax_rate FROM services sx WHERE sx.id = ii.service_id), 0)`;
const ITEM_AFTER_DISCOUNT_SQL = `(ii.total - (${ITEM_DISCOUNT_SQL}))`;
const ITEM_TAX_SQL = `(${ITEM_AFTER_DISCOUNT_SQL} * ${ITEM_TAX_RATE_SQL} / 100.0)`;
const ITEM_NET_SQL = `(${ITEM_AFTER_DISCOUNT_SQL} - ${ITEM_TAX_SQL})`;

// DOCTOR_FIX_RATE_V1 — фиксированная ставка идёт ЗА ЕДИНИЦУ и налогом не режется:
// это оговорённая сумма за услугу, а не доля от выручки. Процент и фикс
// взаимоисключающи: услуга с фиксом процент не платит.
const ITEM_FEE_SQL = `CASE
  WHEN ${ITEM_FIX_SQL} IS NOT NULL THEN ${ITEM_FIX_SQL} * COALESCE(ii.quantity, 1)
  ELSE ${ITEM_NET_SQL} * ${ITEM_PCT_SQL} / 100.0
END`;

function itemRowsQuery(db, args, ctx) {
  const { from, to } = resolveRange(db, args);
  const bf = branchFilter(args, 'i.branch_id');
  // BUILDING_REPORTS_V1 — здание берётся у СЧЁТА, а не у строки счёта: деньги
  // принадлежат тому зданию, которое счёт выставило, и разносить позиции одного
  // счёта по разным зданиям было бы выдумкой.
  const gf = buildingWhere(db, ctx, args, 'invoices', 'i');
  const rows = db.prepare(`
    SELECT ${originExpr(db, 'invoices', 'i')}  AS origin,
           ${localDate('i.created_at')}       AS date,
           i.invoice_number                   AS invoice,
           i.status                           AS status,
           pt.full_name                       AS patient,
           pt.mrn                             AS mrn,
           COALESCE(s.name, ii.description)   AS service,
           ii.quantity                        AS qty,
           ii.unit_price                      AS price,
           ii.total                           AS amount,
           ${ITEM_DISCOUNT_SQL}               AS discount,
           COALESCE(s.tax_rate, 0)            AS tax_rate,
           doc.full_name                      AS doctor,
           ${ITEM_PCT_SQL}                    AS doctor_pct,
           ${ITEM_FIX_SQL}                    AS doctor_fix,
           ${ITEM_FEE_SQL}                    AS doctor_fee,
           b.name                             AS branch,
           reg.full_name                      AS registrar,
           rs.name                            AS referral,
           rs.category                        AS referral_category,
           i.visit_id                         AS visit_id
      FROM invoice_items ii
      JOIN invoices i  ON i.id = ii.invoice_id
      JOIN patients pt ON pt.id = i.patient_id
      LEFT JOIN services s  ON s.id = ii.service_id
      LEFT JOIN branches b  ON b.id = i.branch_id
      LEFT JOIN users reg   ON reg.id = i.created_by
      LEFT JOIN visits v    ON v.id = i.visit_id
      LEFT JOIN referral_sources rs ON rs.id = COALESCE(v.referral_source_id, pt.referral_source_id)
      ${ITEM_DOCTOR_JOIN}
     WHERE ${inLocalRange('i.created_at')}
       AND i.status <> 'void'${bf.clause}${gf.clause}
     ORDER BY origin, i.created_at, ii.id
  `).all(from, to, ...bf.params, ...gf.params);
  return rows;
}

// ---------------------------------------------------------------------------
// PENDING_ITEMS_V1 — деньги, у которых приехала ШАПКА, но не приехали ПОЗИЦИИ.
//
// Счёт едет двумя разными записями. Шапка (invoices) ложится сразу; строка
// счёта (invoice_items) ссылается на услугу ПО КОДУ, и пока такого кода нет в
// справочнике приёмника, она ждёт родителя в sync_pending. Поэтому две семьи
// отчётов НЕ СХОДЯТСЯ, и расходятся они молча:
//
//   отчёты ПО ШАПКАМ   — «Счета», «Собрано» (reports_overview) — деньги ВИДЯТ;
//   отчёты ПО СТРОКАМ  — «Общая выручка», «Отчёт владельца», «Рефералы»,
//                        «Зарплаты врачей», «Рентабельность операций» и
//                        выгрузка в Excel (все они читают itemRowsQuery) — НЕТ.
//
// Замерено ревью на одном таком счёте: 300 в «Собрано» и 300 в «Счетах» против
// 0 в «Общей выручке» и 0 в KPI владельца. Через 30 дней невостребованная
// запись выселяется (branch-sync/records.js, PENDING_MAX_DAYS) — и расхождение
// становится ВЕЧНЫМ, уже без всякой надежды сойтись самому.
//
// Дорисовать недостающие строки НЕЛЬЗЯ: какая это была услуга и чей врач —
// неизвестно, а выдумать их значит подменить данные (то же правило, что у
// подписи «<здание>, врач не указан»). Поэтому считается ОДНА честная величина
// и показывается ОТДЕЛЬНОЙ строкой, а не подмешивается в итог:
//
//   недостача = total_amount − (сумма приехавших строк ПОСЛЕ скидки)
//
// Скидка разносится на строки ровно так же, как в самом отчёте
// (ITEM_DISCOUNT_SQL — доля строки в subtotal), поэтому «шапка минус строки» и
// «итог отчёта» — числа из одной арифметики, а не два независимых счёта.
//
// ТОЛЬКО ПРИЕХАВШИЕ СЧЕТА (sync_origin IS NOT NULL). У своего счёта строкам
// ехать неоткуда: расхождение там означало бы ошибку ввода, а не задержку
// доставки, и смешивать одно с другим — значит перестать понимать оба.
//
// ОДНО ОПРЕДЕЛЕНИЕ НА ВСЕ ОТЧЁТЫ. Сузить недостачу под фильтры каждого отчёта
// («только хирургия», «только оплаченные») невозможно честно: услуги-то как раз
// и не приехали. Пять отчётов дали бы пять разных чисел про один и тот же факт,
// и владельцу пришлось бы выбирать, какому верить.
// ---------------------------------------------------------------------------

// Разряды пробелом, без Intl: число в примечании обязано выглядеть одинаково на
// компьютере клиники и в тесте, какая бы ICU ни была собрана в Node.
function moneyRu(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// РУССКОЕ СКЛОНЕНИЕ ПОСЛЕ ЧИСЛА. «1 счетов» — это не мелочь стиля: примечание
// стоит под денежным отчётом, который владелец показывает бухгалтеру и
// налоговой, и текст, написанный машиной, машине же и верят меньше.
//
// Правило языка, а не таблица исключений: 11–14 — всегда «счетов» (одиннадцать
// счетов), поэтому сотни отбрасываются ПЕРВЫМИ; дальше решает последняя цифра.
// Ровно то же нужно любому будущему примечанию вида «N чего-то» в этом файле —
// зовите отсюда, а не пишите второй раз.
// Экспортируется ради теста: правило языка проверяется на числах 1, 11, 21 и
// 112 напрямую, а не сборкой отчёта на сто одиннадцать счетов.
export function pluralRu(n, one, few, many) {
  const abs = Math.abs(Math.round(Number(n) || 0));
  const hundred = abs % 100;
  if (hundred >= 11 && hundred <= 14) return many;
  const last = abs % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

const PENDING_ITEMS_TAIL = 'Деньги видны в счетах, но строк этих счетов здесь пока нет: какая это услуга и чей врач — неизвестно, поэтому в суммы и в разбивку этого отчёта они НЕ включены. Позиции приедут следующей синхронизацией; если здание молчит, посмотрите «Свежесть данных по зданиям» на странице «Отчёты».';

function pendingItemsNote(p) {
  if (!p || !p.invoices) return null;
  const n = p.invoices;
  return 'Позиции ещё не доехали: ' + n + ' ' + pluralRu(n, 'счёт', 'счета', 'счетов')
    + ', ' + moneyRu(p.amount) + ' сум. ' + PENDING_ITEMS_TAIL;
}

/**
 * Недоехавшие позиции за тот же период и по тем же фильтрам, что и отчёт.
 * @returns {{invoices:number, amount:number, note:string|null, by_building:Array}}
 */
function pendingItemsMoney(db, args, ctx) {
  const empty = {
    invoices: 0,
    amount: 0,
    note: null,
    by_building: summariseByBuilding(ctx, [], { invoices: () => 0, amount: () => 0 }),
  };
  // База, где деньги ещё не научились ездить: приехавших счетов нет по
  // построению, и ссылка на несуществующую колонку уронила бы отчёт.
  if (!hasColumn(db, 'invoices', 'sync_origin')) return empty;

  const { from, to } = resolveRange(db, args);
  const bf = branchFilter(args, 'i.branch_id');
  const gf = buildingWhere(db, ctx, args, 'invoices', 'i');
  const rows = db.prepare(`
    SELECT origin, COUNT(*) AS invoices, COALESCE(SUM(gap), 0) AS amount FROM (
      SELECT ${originExpr(db, 'invoices', 'i')} AS origin,
             COALESCE(i.total_amount, 0)
               - COALESCE((SELECT SUM(ii.total) FROM invoice_items ii WHERE ii.invoice_id = i.id), 0)
                 -- * 1.0 обязательно: subtotal и discount_amount целые, и без
                 -- него SQLite поделил бы нацело — доля скидки стала бы 0 или 1.
                 * (CASE WHEN COALESCE(i.subtotal, 0) > 0
                         THEN (i.subtotal - COALESCE(i.discount_amount, 0)) * 1.0 / i.subtotal
                         ELSE 1.0 END) AS gap
        FROM invoices i
       WHERE i.sync_origin IS NOT NULL
         AND i.status <> 'void'
         AND ${inLocalRange('i.created_at')}${bf.clause}${gf.clause}
    )
     -- Порог, а не «> 0»: суммы целые в сумах, а деление на subtotal — плавающее,
     -- и копеечный хвост округления не должен объявляться недоехавшими деньгами.
     WHERE gap > 0.5
     GROUP BY origin
  `).all(from, to, ...bf.params, ...gf.params);

  const out = {
    invoices: rows.reduce((n, r) => n + (r.invoices || 0), 0),
    amount: round2(rows.reduce((n, r) => n + (r.amount || 0), 0)),
    by_building: summariseByBuilding(ctx, rows, {
      invoices: (r) => r.invoices || 0,
      amount: (r) => r.amount || 0,
    }),
  };
  out.note = pendingItemsNote(out);
  return out;
}

// BUILDING_REPORTS_V1 — общий словарь денежных отчётов.
//
// «Здание» стоит ПЕРВОЙ колонкой: это измерение, по которому владелец читает
// лист сверху вниз, и строки уже отсортированы по нему (itemRowsQuery:
// ORDER BY origin). Существующая колонка «Филиал» осталась и означает ДРУГОЕ —
// branch_id внутри ЭТОЙ базы; см. шапку domain/buildings.js о том, почему это
// два разных измерения.
const BUILDING_COL = 'Здание';

// Складские движения (stock_movements) между зданиями НЕ передаются: у каждой
// установки свой склад. Отчёт, который их считает, обязан это сказать — иначе
// ноль по товарам соседнего здания читается как «там ничего не расходовали».
const STOCK_LOCAL_NOTE = 'Складские движения между зданиями не передаются: количество и стоимость товаров показаны только по этому зданию.';

// Идентификаторы сотрудников (created_by, cashier_id, doctor_id) между
// зданиями не путешествуют, поэтому у приехавшей строки врача нет. Строку
// НЕЛЬЗЯ выбросить — это настоящие деньги; её подписывают зданием.
const UNATTRIBUTED_NOTE = 'У строк соседних зданий не указан врач: между зданиями передаются деньги, но не карточки сотрудников. Такие строки собраны под подписью «<здание>, врач не указан», а не отброшены.';

// Подпись врача в строке. Своя строка без врача остаётся пустой (так было и
// раньше); приехавшая — называется зданием, чтобы сумма не выглядела ничьей.
function doctorCell(ctx, r) {
  if (r.doctor) return r.doctor;
  const key = ctx.keyOf(r.origin);
  return key === ctx.ownKey ? '' : ctx.unattributed(key);
}

// Есть ли в выборке строка чужого здания без врача — только тогда примечание
// об этом уместно.
function hasUnattributed(ctx, rows) {
  return rows.some((r) => !r.doctor && ctx.keyOf(r.origin) !== ctx.ownKey);
}

function totalRevenueReport(db, args, ctx) {
  const src = itemRowsQuery(db, args, ctx);
  return {
    columns: [BUILDING_COL, 'Дата', '№ счёта', 'Пациент', 'МРН', 'Услуга', 'Кол-во', 'Цена', 'Сумма',
              'Скидка', 'После скидки', 'Налог %', 'Налог', 'Врач', 'Ставка врача', 'Доля врача',
              'Филиал', 'Регистратор', 'Реферал', 'Статус'],
    rows: src.map((r) => {
      const after = r.amount - r.discount;
      // DOCTOR_FIX_RATE_V1 — the rate column states WHICH rate applied. Printing
      // a percentage for a fixed-rate line would read as "this doctor gets 0%"
      // next to a non-zero fee.
      const rate = r.doctor_fix != null ? ('фикс ' + round2(r.doctor_fix)) : r.doctor_pct;
      return [ctx.label(r.origin), r.date, r.invoice || '', r.patient, r.mrn || '', r.service || '', r.qty,
              round2(r.price), round2(r.amount), round2(r.discount), round2(after),
              r.tax_rate, round2(after * r.tax_rate / 100), doctorCell(ctx, r), rate,
              round2(r.doctor_fee), r.branch || '', r.registrar || '',
              r.referral || '', INV_STATUS_RU[r.status] || r.status];
    }),
    by_building: summariseByBuilding(ctx, src, {
      total: (r) => r.amount - r.discount,
      doctor_fee: (r) => r.doctor_fee || 0,
    }),
    total_label: 'После скидки',
    notes: hasUnattributed(ctx, src) ? [UNATTRIBUTED_NOTE] : [],
  };
}

function referralsReport(db, args, ctx) {
  const rewards = db.prepare('SELECT name, percent FROM referral_rewards WHERE active = 1').all();
  const rewardByName = new Map(rewards.map((r) => [r.name.trim().toLowerCase(), r.percent]));
  // Ключ корзины — ЗДАНИЕ и источник. Один и тот же партнёр может приводить
  // пациентов в оба здания, и складывать их в одну строку значило бы стереть
  // ровно то, что этот отчёт теперь обязан показывать.
  const buckets = new Map();
  for (const r of itemRowsQuery(db, args, ctx)) {
    if (!r.referral) continue;
    const key = ctx.keyOf(r.origin) + '\u0000' + r.referral;
    const b = buckets.get(key) || {
      origin: r.origin, source: r.referral, category: r.referral_category || '', count: 0, amount: 0,
    };
    b.count += 1;
    b.amount += r.amount - r.discount;
    buckets.set(key, b);
  }
  const list = [...buckets.values()].sort((a, b) => b.amount - a.amount);
  const rows = list.map((b) => {
    // «Вручную» — a reward rate named exactly like the source; «Общий» — a
    // rate named like the source's category; otherwise 0%.
    const own = rewardByName.get(b.source.trim().toLowerCase());
    const cat = rewardByName.get((b.category || '').trim().toLowerCase());
    const pct = own != null ? own : (cat != null ? cat : 0);
    const mode = own != null ? 'Вручную' : 'Общий';
    return [ctx.label(b.origin), b.source, b.category, mode, b.count, round2(b.amount), pct,
            round2(b.amount * pct / 100)];
  });
  return {
    columns: [BUILDING_COL, 'Источник', 'Категория', 'Режим ставок', 'Услуг', 'Сумма услуг',
              '% вознаграждения', 'Вознаграждение'],
    rows,
    by_building: summariseByBuilding(ctx, list, { total: (b) => b.amount }),
    total_label: 'Сумма услуг',
    notes: [],
  };
}

function invoicesFullReport(db, args, ctx) {
  const { from, to } = resolveRange(db, args);
  const bf = branchFilter(args, 'i.branch_id');
  const gf = buildingWhere(db, ctx, args, 'invoices', 'i');
  const rows = db.prepare(`
    SELECT ${originExpr(db, 'invoices', 'i')} AS origin,
           i.invoice_number AS number, ${localDate('i.created_at')} AS created,
           pt.full_name AS patient, pt.mrn AS mrn, pt.phone AS phone,
           b.name AS branch, py.name AS payer,
           i.subtotal AS subtotal, i.discount_amount AS discount,
           i.total_amount AS total, i.paid_amount AS paid, i.status AS status,
           COALESCE(${localDate('i.paid_at')}, '') AS paid_at, reg.full_name AS registrar,
           -- INVOICE_METHOD_COLUMN_V1 — чем платили. Подзапросом, а не JOIN'ом:
           -- у счёта может быть НЕСКОЛЬКО платежей (record_payment_split —
           -- часть наличными, часть картой), и join размножил бы строку счёта
           -- по числу оплат, испортив все суммы правее. Тот же приём, что в
           -- rpc/cashier.js для списка счетов кассы.
           (SELECT GROUP_CONCAT(DISTINCT p.method) FROM payments p WHERE p.invoice_id = i.id) AS methods
      FROM invoices i
      JOIN patients pt ON pt.id = i.patient_id
      LEFT JOIN branches b ON b.id = i.branch_id
      LEFT JOIN payers py  ON py.id = pt.payer_id
      LEFT JOIN users reg  ON reg.id = i.created_by
     WHERE ${inLocalRange('i.created_at')}${bf.clause}${gf.clause}
     ORDER BY origin, i.created_at DESC
  `).all(from, to, ...bf.params, ...gf.params);
  return {
    columns: [BUILDING_COL, '№ счёта', 'Дата', 'Пациент', 'МРН', 'Телефон', 'Филиал', 'Кто платит',
              'Сумма без скидки', 'Скидка', 'Итого', 'Оплачено', 'Остаток / долг',
              'Статус', 'Способ оплаты', 'Дата оплаты', 'Регистратор'],
    rows: rows.map((r) => [ctx.label(r.origin), r.number || '', r.created, r.patient, r.mrn || '', r.phone || '',
      r.branch || '', r.payer || 'Пациент', round2(r.subtotal), round2(r.discount),
      round2(r.total), round2(r.paid), round2(Math.max(r.total - r.paid, 0)),
      INV_STATUS_RU[r.status] || r.status,
      // GROUP_CONCAT возвращает "cash,card" одной строкой — режем и отдаём в
      // общий с браузером словарь, чтобы оба отчёта «Счета» называли один и тот
      // же платёж одинаково.
      formatMethods(String(r.methods || '').split(',')),
      r.paid_at || '', r.registrar || '']),
    by_building: summariseByBuilding(ctx, rows, {
      total: (r) => r.total || 0,
      paid: (r) => r.paid || 0,
    }),
    total_label: 'Итого по счетам',
    notes: [],
  };
}

function procurementReport(db, args, ctx) {
  const { from, to } = resolveRange(db, args);
  const bf = branchFilter(args, 'sm.branch_id');
  // Метки происхождения у stock_movements нет и не будет — склад не ездит.
  // buildingWhere об этом знает: «только соседнее здание» вернёт пусто, а не
  // молча свои же поступления под чужим именем.
  const gf = buildingWhere(db, ctx, args, 'stock_movements', 'sm');
  const rows = db.prepare(`
    SELECT ${originExpr(db, 'stock_movements', 'sm')} AS origin,
           ${localDate('sm.created_at')} AS date, pr.name AS product, sm.note AS note,
           sm.qty AS qty, sm.unit_cost AS unit_cost
      FROM stock_movements sm
      JOIN products pr ON pr.id = sm.product_id
     WHERE sm.kind = 'receive'
       AND ${inLocalRange('sm.created_at')}${bf.clause}${gf.clause}
     ORDER BY sm.created_at DESC
  `).all(from, to, ...bf.params, ...gf.params);
  return {
    columns: [BUILDING_COL, 'Дата', 'Товар', 'Поставщик / примечание', 'Количество', 'Цена за ед.', 'Сумма'],
    rows: rows.map((r) => [ctx.label(r.origin), r.date, r.product, r.note || '', r.qty,
      r.unit_cost == null ? null : round2(r.unit_cost),
      round2(r.qty * (r.unit_cost || 0))]),
    by_building: summariseByBuilding(ctx, rows, { total: (r) => r.qty * (r.unit_cost || 0) }),
    total_label: 'Сумма закупок',
    notes: [STOCK_LOCAL_NOTE],
  };
}

const SURGERY_RE = /хирург|операц|surg|operat/i;

function surgeryProfitReport(db, args, ctx) {
  // Consumables per visit: dispense movements reference visit_services
  // (reference_type 'visit', reference_id = visit_service id). qty is negative
  // on dispense; cost falls back to the product's rolling average.
  const consumablesByVisit = new Map();
  for (const c of db.prepare(`
    SELECT vs2.visit_id AS visit_id,
           SUM(-sm.qty * COALESCE(sm.unit_cost, pr.avg_cost, 0)) AS cost
      FROM stock_movements sm
      JOIN visit_services vs2 ON vs2.id = sm.reference_id
      JOIN products pr ON pr.id = sm.product_id
     WHERE sm.kind = 'dispense' AND sm.reference_type = 'visit'
     GROUP BY vs2.visit_id
  `).all()) consumablesByVisit.set(c.visit_id, Math.max(c.cost, 0));

  // SQLite lower() doesn't fold Cyrillic, so the «хирургия» match runs in JS.
  const src = itemRowsQuery(db, args, ctx)
    .filter((r) => SURGERY_RE.test(r.service || ''));
  const computed = src.map((r) => {
    const invoiced = r.amount - r.discount;
    const tax = invoiced * r.tax_rate / 100;
    // DOCTOR_SHARE_AFTER_TAX_V1 — гонорар хирурга считается от суммы ПОСЛЕ
    // налога, как и доля врача везде. Здесь это было особенно заметно: строкой
    // ниже налог вычитается из прибыли клиники, то есть один и тот же налог
    // клиника «отдавала» дважды — государству и в базу гонорара.
    // Фиксированную ставку (если она задана на услугу) берём из общего
    // расчёта: она за единицу и налогом не режется.
    const surgeonFee = r.doctor_fix != null ? r.doctor_fee : (invoiced - tax) * r.doctor_pct / 100;
    // Расходники есть только у своего здания: движения склада не ездят.
    const products = r.visit_id != null ? (consumablesByVisit.get(r.visit_id) || 0) : 0;
    const profit = invoiced - tax - surgeonFee - products;
    return { origin: r.origin, doctor: r.doctor, invoiced, profit, row: [
      ctx.label(r.origin), r.patient, r.service, round2(invoiced), r.tax_rate, round2(tax),
      round2(surgeonFee), round2(products), round2(profit),
      invoiced > 0 ? round2(profit / invoiced * 100) : 0] };
  });
  const notes = [STOCK_LOCAL_NOTE];
  if (hasUnattributed(ctx, src)) notes.push(UNATTRIBUTED_NOTE);
  return {
    columns: [BUILDING_COL, 'Пациент', 'Операция', 'Сумма по счёту', 'Ставка налога (%)', 'Налог',
              'Гонорар хирурга', 'Расходники (товары)', 'Прибыль клиники', 'Маржа (%)'],
    rows: computed.map((c) => c.row),
    by_building: summariseByBuilding(ctx, computed, {
      total: (c) => c.invoiced,
      profit: (c) => c.profit,
    }),
    total_label: 'Сумма по счетам',
    notes,
  };
}

function doctorSalariesReport(db, args, ctx) {
  const { from, to } = resolveRange(db, args);
  const bf = branchFilter(args, 'i.branch_id');
  const gf = buildingWhere(db, ctx, args, 'invoices', 'i');
  // BUILDING_REPORTS_V1 — приехавшая строка НЕ ОТБРАСЫВАЕТСЯ.
  //
  // Здесь стояло `AND vs.doctor_id IS NOT NULL` — правило «в зарплатном отчёте
  // только то, что привязано к врачу». Для своего здания оно верное и остаётся.
  // Но у строки соседнего здания врача нет и быть не может: карточки
  // сотрудников между зданиями не путешествуют. Прежнее условие выбрасывало
  // такую строку молча, и оплаченные услуги второго здания просто исчезали из
  // отчёта. Теперь они остаются — одной строкой на здание с подписью
  // «<здание>, врач не указан».
  const foreignKeep = hasColumn(db, 'invoices', 'sync_origin') ? ' OR i.sync_origin IS NOT NULL' : '';
  const rows = db.prepare(`
    SELECT ${originExpr(db, 'invoices', 'i')} AS origin,
           doc.full_name AS doctor,
           COUNT(ii.id)  AS services_count,
           SUM(ii.total - ${ITEM_DISCOUNT_SQL}) AS after_discount,
           -- DOCTOR_FIX_RATE_V1 — averaged over the PERCENTAGE lines only; a
           -- fixed-rate line has no percentage, and folding it in as 0 would
           -- drag the average down and misreport the doctor's terms.
           AVG(CASE WHEN ${ITEM_FIX_SQL} IS NULL THEN ${ITEM_PCT_SQL} END) AS avg_pct,
           SUM(CASE WHEN ${ITEM_FIX_SQL} IS NOT NULL THEN 1 ELSE 0 END)    AS fixed_lines,
           SUM(${ITEM_FEE_SQL})                 AS fee
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      ${ITEM_DOCTOR_JOIN}
     WHERE i.status = 'paid'
       AND (vs.doctor_id IS NOT NULL${foreignKeep})
       AND ${inLocalRange('i.created_at')}${bf.clause}${gf.clause}
     GROUP BY origin, vs.doctor_id
     ORDER BY origin, after_discount DESC
  `).all(from, to, ...bf.params, ...gf.params);
  return {
    columns: [BUILDING_COL, 'Врач', 'Оплаченных услуг', 'Сумма после скидки', 'Средний % врача',
              'Услуг по фикс. ставке', 'Доля врача (гонорар)'],
    // avg_pct is NULL when every line was fixed-rate — print '—' rather than 0,
    // which would claim the doctor works for nothing.
    rows: rows.map((r) => [ctx.label(r.origin), doctorCell(ctx, r) || '—', r.services_count,
      round2(r.after_discount),
      r.avg_pct == null ? '—' : round2(r.avg_pct), r.fixed_lines || 0, round2(r.fee)]),
    by_building: summariseByBuilding(ctx, rows, {
      total: (r) => r.after_discount || 0,
      fee: (r) => r.fee || 0,
    }),
    total_label: 'Сумма после скидки',
    notes: hasUnattributed(ctx, rows) ? [UNATTRIBUTED_NOTE] : [],
  };
}

const REPORTS_RU = {
  total_revenue:    totalRevenueReport,
  referrals:        referralsReport,
  invoices_full:    invoicesFullReport,
  procurement:      procurementReport,
  surgery_profit:   surgeryProfitReport,
  doctor_salaries:  doctorSalariesReport,
};

// OWNER_REPORT_V1 — chart data for «Отчёт владельца»: period KPIs, last-12-months
// revenue (independent of the selected period, like production), revenue by
// service (local schema has no service groups), receipts by payer kind.
const OWNER_M_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export function ownerReport(db, args, _user) {
  const { from, to } = resolveRange(db, args);
  const bf = branchFilter(args, 'i.branch_id');
  // BUILDING_REPORTS_V1 — отчёт владельца тоже смотрит на клинику целиком:
  // фильтр по зданиям и разрез рядом с KPI. Без этого «Общая выручка» на
  // главном экране владельца показывала выручку одного здания и называла её
  // общей.
  const ctx = buildingContext(db);
  const gf = buildingWhere(db, ctx, args, 'invoices', 'i');

  const base = `
    FROM invoice_items ii
    JOIN invoices i  ON i.id = ii.invoice_id
    JOIN patients pt ON pt.id = i.patient_id
    LEFT JOIN payers py ON py.id = pt.payer_id
    LEFT JOIN services s ON s.id = ii.service_id
   WHERE i.status <> 'void'${bf.clause}${gf.clause}`;

  const k = db.prepare(`
    SELECT COALESCE(SUM(ii.total - ${ITEM_DISCOUNT_SQL}), 0) AS revenue, COUNT(ii.id) AS count
    ${base} AND ${inLocalRange('i.created_at')}
  `).get(...bf.params, ...gf.params, from, to);

  const byGroupRaw = db.prepare(`
    SELECT COALESCE(s.name, ii.description) AS name,
           SUM(ii.total - ${ITEM_DISCOUNT_SQL}) AS value
    ${base} AND ${inLocalRange('i.created_at')}
     GROUP BY COALESCE(s.name, ii.description)
     ORDER BY value DESC
  `).all(...bf.params, ...gf.params, from, to);
  const byGroup = byGroupRaw.slice(0, 8).map((g) => ({ name: g.name || '—', value: Math.round(g.value) }));
  const rest = byGroupRaw.slice(8).reduce((s, g) => s + g.value, 0);
  if (rest > 0) byGroup.push({ name: 'Прочее', value: Math.round(rest) });

  // Last 12 calendar months, oldest first.
  const monthly = [];
  const now = new Date(today(db) + 'T00:00:00Z');
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    monthly.push({ key, label: OWNER_M_RU[d.getUTCMonth()], value: 0 });
  }
  const mIdx = new Map(monthly.map((m, i) => [m.key, i]));
  for (const r of db.prepare(`
    SELECT ${localMonth('i.created_at')} AS ym,
           SUM(ii.total - ${ITEM_DISCOUNT_SQL}) AS value
    ${base} AND ${localMonth('i.created_at')} >= ?
     GROUP BY ym
  `).all(...bf.params, ...gf.params, monthly[0].key)) {
    const i = mIdx.get(r.ym);
    if (i != null) monthly[i].value = Math.round(r.value);
  }
  for (const m of monthly) delete m.key;

  const P = { patient: 0, insurance: 0, corporate: 0, state: 0 };
  for (const r of db.prepare(`
    SELECT py.kind AS kind, py.id AS payer_id,
           SUM(ii.total - ${ITEM_DISCOUNT_SQL}) AS value
    ${base} AND ${inLocalRange('i.created_at')}
     GROUP BY py.id
  `).all(...bf.params, ...gf.params, from, to)) {
    if (r.payer_id == null) P.patient += r.value;
    else if (r.kind === 'corporate' || r.kind === 'b2b') P.corporate += r.value;
    else if (r.kind === 'state' || r.kind === 'government') P.state += r.value;
    else P.insurance += r.value;
  }
  const byPayer = [
    { label: 'Пациент (самооплата)', color: '#0d8a72', value: Math.round(P.patient) },
    { label: 'ДМС / Страховка',      color: '#2563eb', value: Math.round(P.insurance) },
    { label: 'B2B (корпоратив)',     color: '#b45309', value: Math.round(P.corporate) },
    { label: 'Госпрограмма',         color: '#7c3aed', value: Math.round(P.state) },
  ].filter((x) => x.value > 0);

  // Разрез по зданиям — рядом с KPI, теми же деньгами и тем же периодом.
  const perBuilding = db.prepare(`
    SELECT ${originExpr(db, 'invoices', 'i')} AS origin,
           SUM(ii.total - ${ITEM_DISCOUNT_SQL}) AS value, COUNT(ii.id) AS count
    ${base} AND ${inLocalRange('i.created_at')}
     GROUP BY origin
  `).all(...bf.params, ...gf.params, from, to);
  const buildings = summariseByBuilding(ctx, perBuilding, {
    total: (r) => r.value || 0,
    count: (r) => r.count || 0,
  }).map((b2) => ({ key: b2.key, label: b2.label, own: b2.own, value: Math.round(b2.total), count: b2.count }));

  return {
    kpis: {
      revenue: Math.round(k.revenue),
      count: k.count,
      avg: k.count ? Math.round(k.revenue / k.count) : 0,
    },
    monthly, byGroup, byPayer, buildings, from, to,
    // PENDING_ITEMS_V1 — KPI владельца считается по СТРОКАМ счетов, значит
    // недоехавших позиций в нём нет. Это ровно тот экран, где «выручка 0» при
    // непустой кассе пугает сильнее всего, поэтому недостача едет рядом с KPI.
    pending_items: pendingItemsMoney(db, args, ctx),
  };
}

// PENDING_ITEMS_V1 — отчёты, которые читают СТРОКИ счетов (itemRowsQuery либо
// прямой запрос по invoice_items). Ровно им и не хватает недоехавших позиций;
// «Счета» и «Закупки» считают по шапкам и по складу, у них этой дыры нет.
const ITEM_BASED_REPORTS = new Set([
  'total_revenue', 'referrals', 'surgery_profit', 'doctor_salaries',
]);

export function runReport(db, args, _user) {
  const kind = args && args.kind;
  const ru = REPORTS_RU[kind];
  if (ru) {
    const ctx = buildingContext(db);
    const { columns, rows, by_building, notes, total_label } = ru(db, args, ctx);
    return {
      kind, columns, rows,
      by_building: by_building || [], notes: notes || [], total_label: total_label || '',
      // Считается ОДИН раз на отчёт и тем же контекстом зданий, что и сам отчёт:
      // разъехавшийся ctx дал бы недостачу под другими подписями.
      pending_items: ITEM_BASED_REPORTS.has(kind) ? pendingItemsMoney(db, args, ctx) : null,
    };
  }
  const report = legacyReports(db)[kind];
  if (!report) {
    throw new RpcError('unknown report kind: ' + kind, 400);
  }
  const { from, to } = resolveRange(db, args);
  const ctx = buildingContext(db);
  const bf = buildingWhere(db, ctx, args, report.table, report.alias);

  const raw = db.prepare(report.sql(bf)).all(from, to, ...bf.params);
  // BUILDING_REPORTS_V1 — «Здание» приписывается ПОСЛЕДНЕЙ колонкой: у этих
  // выгрузок порядок колонок читают по позиции, и вставка в середину сдвинула
  // бы всё, что правее.
  return {
    kind,
    columns: [...report.columns, 'Здание'],
    rows: raw.map((r) => [...report.row(r), ctx.label(r.origin)]),
    by_building: summariseByBuilding(ctx, raw, {}),
    notes: [],
  };
}

// BUILDING_REPORTS_V1 — перечень ЗДАНИЙ для выборки в «Отчётах».
//
// Отдельный RPC, а не выборка из `branches` через /api/db, по двум причинам,
// и обе делали прежний список неправильным: реестр не отдаёт браузеру колонку
// `letter`, а выборка филиалов грузилась с `.eq('active', 1)` — соседнее
// здание же заводится как `active = 0`, то есть в списке его быть НЕ МОГЛО.
// Здесь список собирается из трёх источников сразу (перечень + своя буква +
// буквы, встреченные в данных), поэтому здание нельзя потерять ни одним из
// трёх способов.
export function reportBuildings(db, _args, _user) {
  const ctx = buildingContext(db);
  return {
    own_letter: ctx.ownLetter,
    own_key: ctx.ownKey,
    buildings: ctx.options.map((o) => ({
      key: o.key, letter: o.letter, own: o.own, label: ctx.label(o.key),
    })),
  };
}

// ---------------------------------------------------------------------------
// BUILDING_FRESHNESS_V1 — ОДИН экран, на котором видно, что данные ещё едут.
//
// Всё, что делают отчёты по зданиям, держится на невысказанном допущении: что
// записи соседнего здания уже приехали. Когда они НЕ приехали, каждый отчёт
// врёт по-своему и молча:
//
//   * `status` счёта путешествует, а `paid_amount` пересчитывается на месте
//     (recomputePaid), и в окно доставки счёт честно показывает «Оплачен ·
//     Оплачено 0 · Остаток 100 000». Это верно по построению и само себя
//     исправит следующей порцией — но без строки «данные ещё приходят»
//     выглядит как пропавшие деньги;
//   * строка счёта ждёт в sync_pending неизвестного справочнику кода услуги —
//     см. PENDING_ITEMS_V1 выше;
//   * запись, которую база не приняла, лежит в sync_refused и не приедет уже
//     никогда сама;
//   * а выключенное (или просто не выходящее на связь) здание не даёт НИЧЕГО,
//     и ноль напротив него неотличим от честного «там сегодня не работали».
//
// Поэтому здесь собирается ровно то, что об этом знает база, — по зданиям и
// без единой догадки. Источники уже есть, их просто никто не показывал:
//   sync_peers   — с кем связь: recv_upto (докуда применён его журнал), last_ok
//                  (когда мы ему выложились), last_ack (когда от него последний
//                  раз приходила квитанция, то есть когда мы его слышали),
//                  seed_floor/seed_page (идёт ли первичная загрузка),
//                  clock_skew_ms (насколько его часы уходят вперёд);
//   sync_pending — сколько записей ждёт родителя. Буква здания у них зашита в
//                  МЕТКУ (stampLetter), отдельной колонки нет;
//   sync_refused — сколько записей база НЕ приняла и что именно она сказала;
//   control_state — общие по клинике попытки обмена (branch_sync_last_attempt /
//                  _last_ok) и последняя выгрузка копии (branch_sync_relay_journal).
//
// ВЕРСИИ СОСЕДА ЗДЕСЬ НЕТ И БЫТЬ НЕ МОЖЕТ. В обмене едет только версия ФОРМАТА
// блоба (`v: 1`), а версия программы соседа — нет. Честный ответ «отсюда не
// видно» лучше выдуманного: version_known = false говорит это прямо, а
// refused_error показывает то единственное, что о расхождении сборок реально
// известно — текст, которым база отказала принять запись.
//
// ЧИСТОЕ ЧТЕНИЕ. Ни одного INSERT: открытие «Отчётов» не должно ничего писать.
// ---------------------------------------------------------------------------

const FRESHNESS_VERSION_NOTE = 'Версия программы соседнего здания в обмене не передаётся — определить её отсюда нельзя. Если записи не принимаются, причина видна в тексте отказа.';

/** JSON-значение control_state; испорченная запись — это «неизвестно», а не 500. */
function jsonState(db, key) {
  if (!hasColumn(db, 'control_state', 'value')) return null;
  try {
    const row = db.prepare('SELECT value FROM control_state WHERE key = ?').get(key);
    if (!row || !row.value) return null;
    const v = JSON.parse(row.value);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) { return null; }
}

/** Сколько записей ждёт родителя, по букве здания из метки. */
function pendingByLetter(db) {
  const byLetter = new Map();
  let unattributed = 0;
  if (!hasColumn(db, 'sync_pending', 'stamp')) return { byLetter, unattributed };
  try {
    for (const r of db.prepare(
      'SELECT stamp, received_at FROM sync_pending').all()) {
      const letter = stampLetter(r.stamp);
      if (!letter) { unattributed += 1; continue; }
      const prev = byLetter.get(letter) || { n: 0, oldest: null };
      prev.n += 1;
      if (r.received_at && (!prev.oldest || r.received_at < prev.oldest)) prev.oldest = r.received_at;
      byLetter.set(letter, prev);
    }
  } catch (_) { /* таблицы может не быть — тогда и ждать нечему */ }
  return { byLetter, unattributed };
}

/** Сколько записей база не приняла, по соседу, плюс последний текст отказа. */
function refusedByLetter(db) {
  const byLetter = new Map();
  let unattributed = 0;
  if (!hasColumn(db, 'sync_refused', 'peer')) return { byLetter, unattributed };
  try {
    const lastErr = db.prepare('SELECT err FROM sync_refused WHERE peer = ? ORDER BY at DESC LIMIT 1');
    for (const r of db.prepare(
      'SELECT peer, COUNT(*) AS n, MAX(at) AS last FROM sync_refused GROUP BY peer').all()) {
      const letter = normalizeLetter(r.peer);
      if (!letter) { unattributed += r.n; continue; }
      const prev = byLetter.get(letter) || { n: 0, last: null, err: null };
      prev.n += r.n;
      if (r.last && (!prev.last || r.last > prev.last)) prev.last = r.last;
      const e = lastErr.get(r.peer);
      if (e && e.err) prev.err = String(e.err).slice(0, 300);
      byLetter.set(letter, prev);
    }
  } catch (_) { /* таблицы может не быть */ }
  return { byLetter, unattributed };
}

/** Строки sync_peers по букве соседа. */
function peersByLetter(db) {
  const byLetter = new Map();
  if (!hasColumn(db, 'sync_peers', 'node')) return byLetter;
  try {
    for (const p of db.prepare(
      `SELECT node, recv_upto, last_ok, last_ack, clock_skew_ms, seed_floor, seed_page
         FROM sync_peers`).all()) {
      const letter = normalizeLetter(p.node);
      if (letter) byLetter.set(letter, p);
    }
  } catch (_) { /* база старой сборки */ }
  return byLetter;
}

export function reportFreshness(db, _args, _user) {
  const ctx = buildingContext(db);
  const peers = peersByLetter(db);
  const pend = pendingByLetter(db);
  const ref = refusedByLetter(db);

  // Перечень зданий — сначала известные (своё первым), затем буквы, о которых
  // знает только обмен. Здание, приславшее отказ, обязано быть НАЗВАНО, даже
  // если в перечне филиалов его строки нет: иначе самая плохая новость экрана —
  // единственная, которая на него не попадёт.
  const seen = new Set();
  const slots = [];
  for (const o of ctx.options) { slots.push({ key: o.key, letter: o.letter, own: o.own }); seen.add(o.key); }
  for (const letter of [...peers.keys(), ...pend.byLetter.keys(), ...ref.byLetter.keys()]) {
    if (seen.has(letter)) continue;
    seen.add(letter);
    slots.push({ key: letter, letter, own: false });
  }

  const buildings = slots.map(({ key, letter, own }) => {
    // У СВОЕГО здания связи с самим собой нет: строки sync_peers, ожидания и
    // отказы — это всегда про чужие записи. Приписать их себе значило бы
    // объявить, что собственные данные к нам «ещё едут».
    const p = own || !letter ? null : peers.get(letter) || null;
    const pd = own || !letter ? null : pend.byLetter.get(letter) || null;
    const rf = own || !letter ? null : ref.byLetter.get(letter) || null;
    return {
      key,
      letter: letter || null,
      label: ctx.label(key),
      own,
      // Есть ли вообще связь с этим зданием (строка в sync_peers).
      linked: !!p,
      // Когда мы его в последний раз СЛЫШАЛИ: квитанция приходит в каждом его
      // блобе, поэтому это и есть «когда его записи приходили в последний раз».
      last_received: (p && p.last_ack) || null,
      // Когда мы в последний раз успешно выложились ЕМУ — вторая сторона связи.
      last_sent_ok: (p && p.last_ok) || null,
      recv_upto: p ? (p.recv_upto || 0) : 0,
      // Первичная загрузка: страницы нумеруются с нуля, человеку показываем
      // следующую — ту, которая едет сейчас.
      seeding: !!(p && p.seed_floor != null),
      seed_page: p && p.seed_floor != null ? (p.seed_page || 0) + 1 : null,
      clock_skew_ms: p ? (p.clock_skew_ms || 0) : 0,
      pending: pd ? pd.n : 0,
      pending_oldest: pd ? pd.oldest : null,
      refused: rf ? rf.n : 0,
      refused_last: rf ? rf.last : null,
      refused_error: rf ? rf.err : null,
      version: null,
      version_known: false,
    };
  });

  return {
    own_key: ctx.ownKey,
    own_letter: ctx.ownLetter,
    building_count: buildings.length,
    buildings,
    pending_total: buildings.reduce((n, b) => n + b.pending, 0),
    refused_total: buildings.reduce((n, b) => n + b.refused, 0),
    // Ожидания и отказы, чью букву прочитать не удалось: молча приписать их
    // своему зданию было бы той же ошибкой, что и всё, что чинит эта задача.
    pending_unattributed: pend.unattributed,
    refused_unattributed: ref.unattributed,
    last_attempt: jsonState(db, 'branch_sync_last_attempt'),
    last_ok: jsonState(db, 'branch_sync_last_ok'),
    relay_journal: jsonState(db, 'branch_sync_relay_journal'),
    version_note: FRESHNESS_VERSION_NOTE,
    checked_at: new Date().toISOString(),
  };
}
