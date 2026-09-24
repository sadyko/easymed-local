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
// REFERRAL_CATEGORY_RATES_V1 — выбор ставки живёт в ОДНОМ модуле, общем с
// браузером: тот же приём, что у payment-methods.js выше. Отчёт «Рефералы»
// существует дважды — здесь и выгрузкой в reports-export.js, — и две копии
// правила «какая ставка применяется» означали бы две разные суммы к выплате.
import { resolveReferralRate, rewardForLine } from '../../../public/js/shared/referral-reward.js';
// REPORTS_V2 — группа услуги (одна из пяти) подписью раздела каталога: тот же
// модуль, что раскладывает каталог в мастере записи.
import { categoryOf, CAT_ORDER } from '../../../public/js/shared/service-categories.js';
// REPORTS_V2 — отчёты склада: КОМУ и НА КОГО тем же SQL, что журнал движений,
// а партии и их остатки — тем же расчётом, что экран «Сроки годности».
import { holderNameSql, movementPatientSql } from './stock-log.js';
import { lotBalances, EXPIRING_SOON_DAYS } from './expiry.js';
// REPORTS_V2, ревью I6 — кто видит начисления врача: сам врач или тот, кому
// открыт раздел «Отчёты» (ключ справочника прав 'reports', прежний раздел
// 'reports-hub'), и администратор.
import { grantAllowsOr } from '../grants.js';
import { hasAnyRole, canViewSection } from '../roles.js';

/**
 * Начисления врача (кабинет): свои — всегда; чужие — только администратору и
 * тем, кому открыты «Отчёты» (им и так видны все врачи в «Зарплатах врачей»).
 * Прежде любой вошедший мог спросить чужие деньги по номеру врача.
 */
function assertCanSeeDoctorPay(db, user, doctorId) {
  if (user && Number(user.id) === Number(doctorId)) return;
  if (user && grantAllowsOr(db, user, 'reports', 'view',
    () => hasAnyRole(user, ['admin']) || canViewSection(db, user, 'reports-hub'))) return;
  throw new RpcError('Можно смотреть только свои начисления.', 403);
}

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

// DOCTOR_TIER_V1 — нумерация строк врача по ТОЧНОЙ услуге внутри календарного
// месяца (по дате визита, местное время; хвост — по id строки). Считается
// строка, которая ОПЛАЧЕНА или которую врач НАЧАЛ/ЗАВЕРШИЛ — что раньше
// (владелец: «both»). «Начал» для лаборатории — с момента взятия материала:
// у неё своя лестница статусов (миграция 041) added → queued → collected →
// in_progress → resulted → completed, и работа по строке идёт уже с collected.
// running — накопленное количество единиц; у строки, чьё
// running перешагнуло порог, за порог выходит units_above единиц — они и идут
// по ступени, остальные — по личной ставке. В выборке только услуги со
// ступенью: без неё подзапрос пуст и отчёты не меняют ни одной цифры.
// Одно место на всю систему: и отчёты, и кабинет (doctor_tier_positions).
//
// DOCTOR_TIER_V2 (миграция 147) — до трёх ступеней. Ступень 2/3 действует,
// только если заполнены все ступени до неё и её порог СТРОГО выше предыдущего
// (service_save и импорт так и проверяют; здесь то же условие ещё раз, чтобы
// кривая строка, пришедшая мимо них, не дала отрицательных полос). Иначе её
// порог читается как 0 — «ступени нет».
// Правка ревью: страховка проверяет и ПАРЫ — порог без доли платил бы полосу
// по личной ставке, ниже ступени 1. Ступень действует, только если её пара
// полна, предыдущая действует и порог выше предыдущего.
const TIER2_OK = `(s.doctor_tier_percent > 0 AND s.doctor_tier_percent_2 > 0
               AND s.doctor_tier_from_2 > s.doctor_tier_from)`;
const TIER3_OK = `(s.doctor_tier_percent_3 > 0 AND s.doctor_tier_from_3 > s.doctor_tier_from_2)`;
export const TIER_RANK_SQL = `
  SELECT r.id AS visit_service_id, r.doctor_id, r.service_id, r.qty, r.ym,
         s.doctor_tier_from AS tier_from, s.doctor_tier_percent AS tier_percent,
         CASE WHEN ${TIER2_OK} THEN s.doctor_tier_from_2 ELSE 0 END AS tier_from_2,
         s.doctor_tier_percent_2 AS tier_percent_2,
         CASE WHEN ${TIER2_OK} AND ${TIER3_OK} THEN s.doctor_tier_from_3 ELSE 0 END AS tier_from_3,
         s.doctor_tier_percent_3 AS tier_percent_3,
         SUM(r.qty) OVER (PARTITION BY r.doctor_id, r.service_id, r.ym
                          ORDER BY r.visit_date, r.id
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
    FROM (
      SELECT vs.id, vs.doctor_id, vs.service_id,
             -- Количество берём там же, где его берёт гонорар: у строки счёта,
             -- если она есть, иначе у строки визита.
             MAX(COALESCE(ti.quantity, vs.quantity, 1), 1) AS qty,
             v.visit_date, ${localMonth('v.visit_date')} AS ym
        FROM visit_services vs
        JOIN visits v ON v.id = vs.visit_id
        LEFT JOIN invoice_items ti ON ti.id = vs.invoice_item_id
        LEFT JOIN invoices tinv ON tinv.id = ti.invoice_id
       WHERE vs.doctor_id IS NOT NULL AND vs.service_id IS NOT NULL
         AND (tinv.status = 'paid'
              OR vs.status IN ('collected', 'in_progress', 'resulted', 'completed'))
    ) r
    JOIN services s ON s.id = r.service_id AND s.doctor_tier_from > 0
`;

// INPATIENT_SHARE_V1 — стационарная доля врача (владелец, 23.09): отдельный
// «Стационар, %» на каждую услугу в карточке сотрудника (users.service_rates,
// ключ inpatient_pct). Правило:
//
//   КОМУ     — исполнителю строки стационара (admission_services.performer_id,
//              миграция 102); нет исполнителя — назначившему (doctor_id).
//              Исполнитель без своей стационарной доли получает 0, и доля
//              при этом НЕ переходит к назначившему: платится тому, кто
//              сделал, ровно как решил владелец;
//   ЧТО      — только медицинские услуги: service_id задан, это не расходник
//              (clinic_item_id) и не койко-дни (service_id NULL и/или
//              примечание «ACCOMMODATION…», shared/accommodation-line.js);
//   СКОЛЬКО  — (строка − доля скидки счёта − налог) × inpatient_pct, тем же
//              ITEM_NET_SQL, что и амбулаторная доля. Фиксированной ставки
//              у стационара нет. Ключа inpatient_pct нет — доля 0: амбулаторный
//              процент и service_rate_default НЕ подставляются (стационарная
//              доля — отдельное решение клиники, а не копия амбулаторной);
//   КОГДА    — только оплаченные счета (это условие ставят отчёты, как и для
//              амбулаторной доли);
//   СТУПЕНИ  — DOCTOR_TIER_V1/V2 к стационару НЕ применяются, и строки
//              стационара НЕ идут в счёт ступени: пороги владелец задавал по
//              амбулаторным приёмам (TIER_RANK_SQL читает только visit_services).
//
// Одна строка стационара на строку счёта: buildAdmissionInvoice пишет каждой
// admission_service свою invoice_item; MIN(id) — страховка от дублей, чтобы
// JOIN не размножил строку счёта.
const INPATIENT_LINE_PICK_SQL = `(
    SELECT MIN(x.id) FROM admission_services x
     WHERE x.invoice_item_id = ii.id
       AND x.service_id IS NOT NULL
       -- Ревью M5: строка стационара — ТА ЖЕ услуга, что строка счёта. Иначе
       -- чужая строка, ошибочно связанная с этой строкой счёта, дала бы долю
       -- по ставке другой услуги.
       AND x.service_id = ii.service_id
       AND x.clinic_item_id IS NULL
       AND COALESCE(x.notes, '') NOT LIKE 'ACCOMMODATION%'
       AND COALESCE(x.performer_id, x.doctor_id) IS NOT NULL)`;
const INPATIENT_DOCTOR_SQL = `COALESCE(ias.performer_id, ias.doctor_id)`;
// Стационарная доля из карточки: только если ключ задан ЧИСЛОМ.
const INPATIENT_RATE_SQL = `
  SELECT u.id AS doctor_id,
         CAST(json_extract(j.value, '$.service_id') AS INTEGER) AS service_id,
         MAX(CAST(json_extract(j.value, '$.inpatient_pct') AS REAL)) AS inpatient_pct
    FROM users u, json_each(u.service_rates) j
   WHERE u.service_rates IS NOT NULL AND u.service_rates != ''
     AND json_valid(u.service_rates)
     AND json_type(j.value, '$.inpatient_pct') IN ('integer', 'real')
   GROUP BY u.id, CAST(json_extract(j.value, '$.service_id') AS INTEGER)`;
const INPATIENT_PCT_SQL = `COALESCE(idr.inpatient_pct, 0)`;

// One de-duplicated doctor/rate per invoice item: a single visit_service per
// item, and the best active rate per (doctor, service) — plain LEFT JOINs on
// doctor_rates could multiply rows when duplicates exist.
const ITEM_DOCTOR_JOIN = `
  LEFT JOIN (SELECT invoice_item_id, MIN(doctor_id) AS doctor_id, MIN(id) AS visit_service_id
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
  -- Одна строка счёта ↔ несколько visit_services теоретически возможны; ступень
  -- читаем только у строки того же врача, чей процент к строке и применяется.
  LEFT JOIN (${TIER_RANK_SQL}) tr ON tr.visit_service_id = vs.visit_service_id
                                 AND tr.doctor_id = vs.doctor_id
  -- INPATIENT_SHARE_V1 — вторая дорога к врачу: строка стационара. Берётся
  -- ТОЛЬКО когда у строки счёта нет амбулаторного врача (vs пуст), поэтому
  -- амбулаторные строки проходят все выражения ниже бит в бит как раньше.
  LEFT JOIN admission_services ias ON ias.id = ${INPATIENT_LINE_PICK_SQL}
                                  AND vs.doctor_id IS NULL
  LEFT JOIN users idoc ON idoc.id = ${INPATIENT_DOCTOR_SQL}
  LEFT JOIN (${INPATIENT_RATE_SQL}) idr ON idr.doctor_id = ${INPATIENT_DOCTOR_SQL}
                                       AND idr.service_id = ii.service_id
`;

// DOC_RATE_JSON_V1 — процент строки: персональная ставка за услугу (таблица или
// JSON карточки), иначе ставка по умолчанию из карточки (service_rate_default).
const ITEM_PCT_SQL = `COALESCE(dr.percent, doc.service_rate_default, 0)`;

// DOCTOR_FIX_RATE_V1 — фиксированная ставка врача за единицу услуги (NULL, если
// врач получает процент). Только из карточки: в таблице doctor_rates фикса нет.
const ITEM_FIX_SQL = `dr.fix`;

// DOCTOR_TIER_V1 — кусочки строки. Единицы строки — не меньше 1, чтобы деление
// ниже никогда не было на ноль.
const ITEM_QTY_SQL = `MAX(COALESCE(ii.quantity, 1), 1)`;
// Единицы, ушедшие за порог: 0..qty. Без ступени (tr пуст) MIN даёт NULL → 0.
const ITEM_ABOVE_SQL = `COALESCE(MAX(0, MIN(${ITEM_QTY_SQL}, tr.running - tr.tier_from)), 0)`;
// DOCTOR_TIER_V2 — единицы за порогами 2 и 3; ступени нет (порог 0) — 0.
// Пороги строго растут (TIER_RANK_SQL), поэтому above ≥ above_2 ≥ above_3.
const itemAboveK = (k) => `CASE WHEN COALESCE(tr.tier_from_${k}, 0) > 0
  THEN MAX(0, MIN(${ITEM_QTY_SQL}, tr.running - tr.tier_from_${k})) ELSE 0 END`;
const ITEM_ABOVE_2_SQL = itemAboveK(2);
const ITEM_ABOVE_3_SQL = itemAboveK(3);
// Процент ступени — не ниже личного: ступень никого не понижает.
const ITEM_TIER_PCT_SQL = `MAX(${ITEM_PCT_SQL}, COALESCE(tr.tier_percent, 0))`;
const ITEM_TIER_PCT_2_SQL = `MAX(${ITEM_PCT_SQL}, COALESCE(tr.tier_percent_2, 0))`;
const ITEM_TIER_PCT_3_SQL = `MAX(${ITEM_PCT_SQL}, COALESCE(tr.tier_percent_3, 0))`;
// Действующий процент строки — смесь по единицам: до первого порога личный,
// дальше каждая единица — по ступени САМОГО ВЫСОКОГО порога, который она
// перешагнула (полосы: above−above_2, above_2−above_3, above_3).
// Ветка без ступени выписана явно: строка без tr идёт по ITEM_PCT_SQL бит в бит,
// а не через арифметику со смесью, где всё держалось бы на MIN(x, NULL).
const ITEM_EFF_PCT_SQL = `CASE WHEN tr.visit_service_id IS NULL THEN ${ITEM_PCT_SQL}
  ELSE ((${ITEM_PCT_SQL} * (${ITEM_QTY_SQL} - ${ITEM_ABOVE_SQL})
       + ${ITEM_TIER_PCT_SQL} * (${ITEM_ABOVE_SQL} - ${ITEM_ABOVE_2_SQL})
       + ${ITEM_TIER_PCT_2_SQL} * (${ITEM_ABOVE_2_SQL} - ${ITEM_ABOVE_3_SQL})
       + ${ITEM_TIER_PCT_3_SQL} * ${ITEM_ABOVE_3_SQL}) / (${ITEM_QTY_SQL} * 1.0)) END`;

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
  -- DOCTOR_TIER_V1 — процент строки берётся действующий (со ступенью выше порога),
  -- а не голый личный; фиксированную ставку ступень не трогает.
  ELSE ${ITEM_NET_SQL} * ${ITEM_EFF_PCT_SQL} / 100.0
END`;

// INPATIENT_SHARE_V1 — доля строки стационара и «одна доля на строку» для
// отчётов, которые показывают обе дороги сразу. Строка без стационарной связи
// (ias пуст) идёт по ITEM_FEE_SQL / ITEM_EFF_PCT_SQL как прежде; ITEM_FIX_SQL
// у строки стационара и так NULL (dr джойнится по амбулаторному врачу).
const INPATIENT_FEE_SQL = `(${ITEM_NET_SQL} * ${INPATIENT_PCT_SQL} / 100.0)`;
const LINE_FEE_SQL = `CASE WHEN ias.id IS NOT NULL THEN ${INPATIENT_FEE_SQL} ELSE ${ITEM_FEE_SQL} END`;
const LINE_PCT_SQL = `CASE WHEN ias.id IS NOT NULL THEN ${INPATIENT_PCT_SQL} ELSE ${ITEM_EFF_PCT_SQL} END`;
const LINE_DOCTOR_ID_SQL = `COALESCE(vs.doctor_id, ${INPATIENT_DOCTOR_SQL})`;

// extra — дополнительное условие отбора (REPORTS_V2, ревью I7: кабинет врача
// сужает выборку до своего источника в SQL, а не отбрасывает в JS строки всей
// клиники).
function itemRowsQuery(db, args, ctx, extra = { clause: '', params: [] }) {
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
           -- INPATIENT_SHARE_V1 — у строки стационара врач свой: исполнитель,
           -- иначе назначивший (idoc); у амбулаторной — прежний doc.
           COALESCE(doc.full_name, idoc.full_name) AS doctor,
           -- DOCTOR_TIER_V1 — «Ставка врача» показывает то, по чему строка
           -- реально оплачена: выше порога это ступень, а не личный процент.
           ${LINE_PCT_SQL}                    AS doctor_pct,
           ${ITEM_FIX_SQL}                    AS doctor_fix,
           ${LINE_FEE_SQL}                    AS doctor_fee,
           ias.id                             AS inpatient_line_id,
           b.name                             AS branch,
           reg.full_name                      AS registrar,
           rs.name                            AS referral,
           -- REFERRAL_CATEGORY_RATES_V1 — id источника и ГРУППА услуги: ставка
           -- теперь своя у каждой группы, поэтому отчёт обязан различать
           -- позиции внутри одной корзины. Название категории приходит из
           -- справочника, а не из бывшей текстовой колонки rs.category.
           rs.id                              AS referral_source_id,
           rs.code                            AS referral_code,
           rc.name                            AS referral_category,
           s.type_id                          AS service_type_id,
           i.visit_id                         AS visit_id,
           -- REPORTS_V2 — для отчётов «Рефералы», «По услугам» и «По врачам»:
           -- кто пациент (считаются РАЗНЫЕ пациенты), внутренний ли источник
           -- (категория с флагом is_internal или источник, связанный с
           -- сотрудником, мигр. 122), группа услуги (одна из пяти, services.type)
           -- и стационар ли это (счёт госпитализации).
           i.patient_id                       AS patient_id,
           rc.is_internal                     AS referral_internal,
           rs.doctor_id                       AS referral_doctor_id,
           ii.service_id                      AS service_id,
           s.type                             AS service_group,
           s.is_lab                           AS service_is_lab,
           i.admission_id                     AS admission_id,
           ${ITEM_TAX_SQL}                    AS tax,
           ${ITEM_NET_SQL}                    AS net,
           ${LINE_DOCTOR_ID_SQL}              AS doctor_id,
           -- INPATIENT_SHARE_V1, ревью I1: стационарная ставка исполнителя
           -- (NULL — ставки нет, доля не начисляется).
           idr.inpatient_pct                  AS inpatient_pct
      FROM invoice_items ii
      JOIN invoices i  ON i.id = ii.invoice_id
      JOIN patients pt ON pt.id = i.patient_id
      LEFT JOIN services s  ON s.id = ii.service_id
      LEFT JOIN branches b  ON b.id = i.branch_id
      LEFT JOIN users reg   ON reg.id = i.created_by
      LEFT JOIN visits v    ON v.id = i.visit_id
      LEFT JOIN referral_sources rs ON rs.id = COALESCE(v.referral_source_id, pt.referral_source_id)
    LEFT JOIN referral_source_categories rc ON rc.id = rs.category_id
      ${ITEM_DOCTOR_JOIN}
     WHERE ${inLocalRange('i.created_at')}
       AND i.status <> 'void'${bf.clause}${gf.clause}${extra.clause}
     ORDER BY origin, i.created_at, ii.id
  `).all(from, to, ...bf.params, ...gf.params, ...extra.params);
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
      const rate = r.doctor_fix != null ? ('фикс ' + round2(r.doctor_fix)) : round2(r.doctor_pct);
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

/// REFERRAL_CATEGORY_RATES_V1 (мигр. 120) — ставка берётся из КАРТОЧКИ источника
// и его категории, а не из правила вознаграждения, названного так же, как они.
// Прежний способ искал ставку сравнением строк, и опечатка в названии молча
// означала 0%: ошибки никто не показывал, партнёру просто не платили.
//
// Считается ПО ПОЗИЦИЯМ, а не по итогу корзины: у одного источника теперь может
// быть своя ставка на каждую группу услуг, и умножить общую сумму на один
// процент больше нельзя.
//
// REPORTS_V2 (владелец, 23.09) — «рефералы: внутренние и внешние, по тому, кто
// направил». Одна выборка строк (referralLines) на три потребителя: сводку по
// направившим (kind 'referrals'), детализацию по строкам (kind
// 'referrals_detail') и кабинет врача (doctor_referral_reward). Три копии
// правила разошлись бы молча — врач видел бы одну сумму, ведомость другую.
//
// БАЗА ВОЗНАГРАЖДЕНИЯ (решение REPORTS_V2): сумма СТРОКИ СЧЁТА после доли скидки
// счёта — то, что клиника действительно взяла за эту услугу, а не цена
// каталога, — и только у ОПЛАЧЕННОГО счёта (status 'paid'), ровно как доля
// врача в «Зарплатах врачей». Неоплаченная строка показывается в суммах, но
// вознаграждения не приносит: платить партнёру с денег, которых клиника не
// получила, значит платить дважды при отмене счёта. Период — по дате счёта.
const REFERRER_SCOPES = ['all', 'internal', 'external'];
const REFERRER_KIND_RU = { internal: 'Внутренний', external: 'Внешний' };

function referrerScope(args) {
  const v = args && args.referrer;
  if (v === undefined || v === null || v === '') return 'all';
  if (!REFERRER_SCOPES.includes(v)) throw new RpcError('referrer must be one of: all, internal, external.', 400);
  return v;
}

// Внутренний — категория с флагом «внутренние врачи» (мигр. 122) ЛИБО источник,
// связанный с сотрудником: у такого источника внешней стороны нет по смыслу.
function isInternalReferral(r) {
  return Number(r.referral_internal) === 1 || r.referral_doctor_id != null;
}

// Ставка словами для детализации: «10 %» или «фикс 30 000».
function rateText(rate) {
  if (!rate) return '0 %';
  return rate.unit === 'fix' ? 'фикс ' + moneyRu(rate.value) : round2(rate.value) + ' %';
}

// Есть ли в клинике хоть одна ненулевая ставка вознаграждения. Нет — отчёт
// говорит об этом словами: иначе столбец нулей читается как «никто никого не
// направлял» или как поломка (на разработческой базе все 37 источников — 0 %).
function anyReferralRate(db) {
  const hasPositive = (raw) => {
    let list = [];
    try { list = typeof raw === 'string' && raw.trim() ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []); } catch { list = []; }
    return Array.isArray(list) && list.some((e) => e && Number(e.value) > 0);
  };
  for (const s of db.prepare("SELECT own_percent, own_rates FROM referral_sources WHERE reward_mode = 'own'").all()) {
    if (Number(s.own_percent) > 0 || hasPositive(s.own_rates)) return true;
  }
  for (const c of db.prepare('SELECT standard_percent, rates FROM referral_source_categories').all()) {
    if (Number(c.standard_percent) > 0 || hasPositive(c.rates)) return true;
  }
  return false;
}

const REFERRAL_ZERO_NOTE = 'У всех источников направлений ставка вознаграждения 0 % — поэтому вознаграждение в этом отчёте 0. Ставки вводятся в «Настройки → Направления» (на категории и на источнике) и в карточке врача, вкладка «Вознаграждение за направления».';
const REFERRAL_BASE_NOTE = 'Вознаграждение считается от суммы строки счёта после скидки и только по оплаченным счетам; неоплаченные строки входят в «Сумму услуг», но вознаграждения не приносят. Период — по дате счёта.';

/**
 * Строки счетов, пришедшие по направлению, с посчитанным вознаграждением.
 * @param {{doctorId?: number}} [opts] — только направления этого сотрудника
 *   (его источник, referral_sources.doctor_id) — для кабинета врача.
 */
function referralLines(db, args, ctx, { doctorId = null } = {}) {
  const scope = referrerScope(args);
  const sources = new Map(db.prepare(
    'SELECT id, name, category_id, reward_mode, own_percent, own_rates, doctor_id FROM referral_sources').all()
    .map((r) => [r.id, r]));
  const categories = new Map(db.prepare(
    'SELECT id, name, standard_percent, rates FROM referral_source_categories').all()
    .map((r) => [r.id, r]));
  const out = [];
  // Кабинет врача — только строки его источника, отбором в SQL.
  const extra = doctorId != null ? { clause: ' AND rs.doctor_id = ?', params: [Number(doctorId)] } : undefined;
  for (const r of itemRowsQuery(db, args, ctx, extra)) {
    if (!r.referral) continue;
    const internal = isInternalReferral(r);
    if (scope === 'internal' && !internal) continue;
    if (scope === 'external' && internal) continue;
    if (doctorId != null && Number(r.referral_doctor_id) !== Number(doctorId)) continue;
    const src = r.referral_source_id != null ? sources.get(r.referral_source_id) : null;
    const cat = src && src.category_id != null ? categories.get(src.category_id) : null;
    const rate = resolveReferralRate({ source: src, category: cat, serviceTypeId: r.service_type_id });
    const paid = r.status === 'paid';
    out.push({
      ...r,
      internal,
      category_name: (cat && cat.name) || r.referral_category || '',
      mode: src && src.reward_mode === 'own' ? 'Своя' : 'По категории',
      rate,
      paid,
      after_discount: r.amount - r.discount,
      reward: paid ? rewardForLine(rate, { amount: r.amount, discount: r.discount, qty: r.qty }) : 0,
    });
  }
  return out;
}

function referralNotes(db, lines) {
  const notes = [REFERRAL_BASE_NOTE];
  if (lines.length && !anyReferralRate(db)) notes.push(REFERRAL_ZERO_NOTE);
  return notes;
}

function referralsReport(db, args, ctx) {
  // Ключ корзины — ЗДАНИЕ и источник. Один и тот же партнёр может приводить
  // пациентов в оба здания, и складывать их в одну строку значило бы стереть
  // ровно то, что этот отчёт теперь обязан показывать.
  //
  // Источник в ключе — ПО ID, а не по имени: ставка принадлежит карточке, и два
  // однофамильца с разными ставками больше не имеют права сложиться в одну
  // строку. Для позиций, чей источник удалён из базы, ключом остаётся имя.
  const lines = referralLines(db, args, ctx);
  const buckets = new Map();
  for (const r of lines) {
    const who = r.referral_source_id != null ? 'id:' + r.referral_source_id : 'nm:' + r.referral;
    const key = ctx.keyOf(r.origin) + '\u0000' + who;
    const b = buckets.get(key) || {
      origin: r.origin, source: r.referral, code: r.referral_code || '',
      kind: r.internal ? 'internal' : 'external',
      category: r.category_name, mode: r.mode,
      patients: new Set(), count: 0, amount: 0, paid: 0, reward: 0,
    };
    b.patients.add(r.patient_id);
    b.count += 1;
    b.amount += r.after_discount;
    if (r.paid) b.paid += r.after_discount;
    b.reward += r.reward;
    buckets.set(key, b);
  }
  const list = [...buckets.values()].sort((a, b) => b.amount - a.amount);
  const rows = list.map((b) => {
    // «Эфф. %» — доля вознаграждения от ОПЛАЧЕННОЙ суммы: одного процента у
    // корзины нет (в ней смешиваются ставки групп и фиксированные суммы), а
    // вознаграждение начисляется только с оплаченного.
    const eff = b.paid ? b.reward / b.paid * 100 : 0;
    return [ctx.label(b.origin), b.code, b.source, REFERRER_KIND_RU[b.kind], b.category, b.mode,
            b.patients.size, b.count, round2(b.amount), round2(b.paid), round2(eff), round2(b.reward)];
  });
  return {
    columns: [BUILDING_COL, 'Номер', 'Источник', 'Вид', 'Категория', 'Режим ставок', 'Пациентов', 'Услуг',
              'Сумма услуг', 'Оплачено', 'Эфф. %', 'Вознаграждение'],
    rows,
    by_building: summariseByBuilding(ctx, list, { total: (b) => b.amount, reward: (b) => b.reward }),
    total_label: 'Сумма услуг',
    notes: referralNotes(db, lines),
  };
}

// REPORTS_V2 — детализация «Рефералов»: строка на каждую услугу счёта, пришедшую
// по направлению. Отдельный kind, а не раскрытие строки: конструктор отчётов
// показывает плоскую таблицу и выгружает её в Excel как есть, и детализация
// должна выгружаться так же.
function referralsDetailReport(db, args, ctx) {
  const lines = referralLines(db, args, ctx);
  return {
    columns: [BUILDING_COL, 'Дата', '№ счёта', 'Статус', 'Номер', 'Источник', 'Вид', 'Пациент', 'МРН',
              'Услуга', 'Кол-во', 'Сумма после скидки', 'Ставка', 'Вознаграждение'],
    rows: lines.map((r) => [ctx.label(r.origin), r.date, r.invoice || '', INV_STATUS_RU[r.status] || r.status,
      r.referral_code || '', r.referral, REFERRER_KIND_RU[r.internal ? 'internal' : 'external'],
      r.patient, r.mrn || '', r.service || '', r.qty, round2(r.after_discount), rateText(r.rate), round2(r.reward)]),
    by_building: summariseByBuilding(ctx, lines, { total: (r) => r.after_discount, reward: (r) => r.reward }),
    total_label: 'Сумма после скидки',
    notes: referralNotes(db, lines),
  };
}

// REPORTS_V2 — вознаграждение врача за направления для кабинета: ТЕ ЖЕ строки,
// что в отчёте (referralLines), отобранные по источнику этого врача. Раньше
// кабинет считал сам — от ЦЕНЫ КАТАЛОГА рекомендаций, включая ещё не дошедших
// и отменённых, — и его сумма не сходилась с отчётом ни на одних данных.
export function doctorReferralReward(db, args, user) {
  const doctorId = Number(args && args.doctor_id);
  if (!Number.isInteger(doctorId) || doctorId <= 0) throw new RpcError('doctor_id must be a positive integer.', 400);
  assertCanSeeDoctorPay(db, user, doctorId);   // ревью I6
  const { from, to } = resolveRange(db, args);
  const ctx = buildingContext(db);
  const lines = referralLines(db, { from, to }, ctx, { doctorId });
  // Разделы кабинета («Вид услуги» / категория) — названиями справочников, как
  // кабинет называет их у рекомендаций: суммы раскладываются по тем же словам.
  const typeName = new Map(db.prepare('SELECT id, name FROM service_types').all().map((t) => [t.id, t.name]));
  const catName = new Map(db.prepare(`SELECT s.id, c.name FROM services s
                                        JOIN service_categories c ON c.id = s.category_id`).all().map((c) => [c.id, c.name]));
  const rows = lines.map((r) => ({
    date: r.date, invoice: r.invoice, status: r.status, paid: r.paid,
    patient: r.patient, mrn: r.mrn || '', service: r.service || '',
    service_type_id: r.service_type_id ?? null,
    service_type: typeName.get(r.service_type_id) || '',
    service_category: catName.get(r.service_id) || '',
    qty: r.qty, amount: round2(r.after_discount), rate: rateText(r.rate), reward: round2(r.reward),
  }));
  return {
    from, to, rows,
    count: rows.length,
    paid_amount: round2(lines.reduce((n, r) => n + (r.paid ? r.after_discount : 0), 0)),
    reward: round2(lines.reduce((n, r) => n + r.reward, 0)),
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

// REPORTS_V2 — «Закупки и склад», четыре вида (владелец выбрал все четыре):
// приход по поставщикам ('procurement'), расход по получателям и пациентам
// ('stock_consumption'), ведомость остатков ('stock_statement') и просроченное
// / истекающее ('stock_expiry'). Склад между зданиями не ездит — все четыре
// считают только своё здание (STOCK_LOCAL_NOTE).
const STOCK_UNIT_SQL = `COALESCE(NULLIF(pr.base_unit, ''), pr.unit, '')`;

// (а) ПРИХОД ПО ПОСТАВЩИКАМ. Поставщик — stock_movements.supplier_id (приход
// через «Принять товар»), у прихода по заказу — поставщик заказа
// (reference_type 'purchase_order', reference_id = заказ). Прежде в колонке
// «Поставщик / примечание» стояло свободное примечание движения, и поставщика
// там не было почти никогда.
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
           sm.qty AS qty, sm.unit_cost AS unit_cost, ${STOCK_UNIT_SQL} AS unit,
           sm.batch_no AS batch_no, sm.expiry_date AS expiry_date,
           sup.name AS supplier
      FROM stock_movements sm
      JOIN products pr ON pr.id = sm.product_id
      LEFT JOIN purchase_orders po ON sm.reference_type = 'purchase_order' AND po.id = sm.reference_id
      LEFT JOIN suppliers sup ON sup.id = COALESCE(sm.supplier_id, po.supplier_id)
     WHERE sm.kind = 'receive'
       AND ${inLocalRange('sm.created_at')}${bf.clause}${gf.clause}
     ORDER BY sup.name IS NULL, sup.name, sm.created_at DESC, sm.id DESC
  `).all(from, to, ...bf.params, ...gf.params);
  const NO_SUPPLIER = 'Поставщик не указан';
  const perSupplier = new Map();
  for (const r of rows) {
    const k = r.supplier || NO_SUPPLIER;
    const t = perSupplier.get(k) || { lines: 0, sum: 0 };
    t.lines += 1; t.sum += r.qty * (r.unit_cost || 0);
    perSupplier.set(k, t);
  }
  // Итоги по поставщикам — примечаниями над таблицей, по убыванию суммы:
  // строка-подытог внутри таблицы попала бы и в общее «Итого» под ней.
  const totals = [...perSupplier.entries()].sort((a, b) => b[1].sum - a[1].sum)
    .map(([name, t]) => 'Итого — ' + name + ': ' + t.lines + ' '
      + pluralRu(t.lines, 'позиция', 'позиции', 'позиций') + ', ' + moneyRu(t.sum) + ' сум.');
  return {
    columns: [BUILDING_COL, 'Дата', 'Поставщик', 'Товар', 'Партия', 'Срок годности', 'Количество', 'Ед.',
              'Цена за ед.', 'Сумма', 'Примечание'],
    rows: rows.map((r) => [ctx.label(r.origin), r.date, r.supplier || NO_SUPPLIER, r.product, r.batch_no || '',
      r.expiry_date || '', r.qty, r.unit || '', r.unit_cost == null ? null : round2(r.unit_cost),
      round2(r.qty * (r.unit_cost || 0)), r.note || '']),
    by_building: summariseByBuilding(ctx, rows, { total: (r) => r.qty * (r.unit_cost || 0) }),
    total_label: 'Сумма закупок',
    notes: [STOCK_LOCAL_NOTE, ...totals],
  };
}

// (б) РАСХОД ПО ОТДЕЛАМ, СОТРУДНИКАМ И ПАЦИЕНТАМ — по себестоимости.
// Журнал STOCK_FLOW_V1: выдача со склада получателю — kind 'dispense' с
// reference_type 'issue'/'requisition' и держателем holder_type/holder_id;
// расход на пациента — 'dispense' с reference_type 'visit'/'admission'
// (держатель — откуда взяли: подотчёт, кабинет, отдел; пусто — склад);
// отмена расхода — 'void' с тем же основанием, количество с плюсом.
// Себестоимость — цена движения, у движения без цены — средняя цена товара.
const ISSUE_REFS = ['issue', 'requisition'];
const PATIENT_REFS = ['visit', 'admission'];
const HOLDER_TYPE_RU = { staff: 'Сотрудник', room: 'Кабинет', department: 'Отдел' };
const CONSUMPTION_KIND_RU = { issue: 'Выдача', patient: 'Расход на пациента', void: 'Отмена расхода' };
const CONSUMPTION_BY = ['lines', 'holder', 'patient'];
const CONSUMPTION_NOTE = 'Себестоимость — цена движения, а у движения без цены — средняя цена товара. «Выдача» — со склада получателю; «Расход на пациента» — из подотчёта, кабинета, отдела или со склада; отмена расхода вычитается.';

function consumptionMovements(db, args, ctx) {
  const { from, to } = resolveRange(db, args);
  const gf = buildingWhere(db, ctx, args, 'stock_movements', 'm');
  const refs = [...ISSUE_REFS, ...PATIENT_REFS];
  return db.prepare(`
    SELECT ${originExpr(db, 'stock_movements', 'm')} AS origin,
           ${localDate('m.created_at')} AS date, m.kind, m.reference_type, m.qty,
           COALESCE(m.unit_cost, pr.avg_cost, 0) AS cost,
           pr.name AS product, ${STOCK_UNIT_SQL} AS unit,
           m.holder_type, m.holder_id, ${holderNameSql('m')} AS holder_name,
           ${movementPatientSql('m')} AS patient, ${movementPatientSql('m', 'id')} AS patient_id,
           COALESCE(u.full_name, u.username) AS actor
      FROM stock_movements m
      JOIN products pr ON pr.id = m.product_id
      LEFT JOIN users u ON u.id = m.created_by
     WHERE m.kind IN ('dispense', 'void')
       AND m.reference_type IN (${refs.map(() => '?').join(', ')})
       AND ${inLocalRange('m.created_at')}${gf.clause}
     ORDER BY m.created_at, m.id
  `).all(...refs, from, to, ...gf.params).map((r) => {
    const kind = r.kind === 'void' ? 'void' : ISSUE_REFS.includes(r.reference_type) ? 'issue' : 'patient';
    const qty = -Number(r.qty || 0);   // расход с плюсом, отмена — с минусом
    const holder = r.holder_type ? (HOLDER_TYPE_RU[r.holder_type] || r.holder_type) + ': ' + (r.holder_name || '#' + r.holder_id) : 'Склад';
    return { ...r, kind, qty, sum: qty * Number(r.cost || 0), holder };
  });
}

function consumptionBy(args) {
  const v = args && args.by;
  if (v === undefined || v === null || v === '') return 'lines';
  if (!CONSUMPTION_BY.includes(v)) throw new RpcError('by must be one of: ' + CONSUMPTION_BY.join(', ') + '.', 400);
  return v;
}

function stockConsumptionReport(db, args, ctx) {
  const by = consumptionBy(args);
  const mv = consumptionMovements(db, args, ctx);
  const notes = [STOCK_LOCAL_NOTE, CONSUMPTION_NOTE];
  if (by === 'holder') {
    // По получателю: сколько ему выдали со склада и сколько из его рук (или со
    // склада, если держателя нет) ушло на пациентов.
    const buckets = new Map();
    for (const r of mv) {
      const key = ctx.keyOf(r.origin) + '\u0000' + r.holder;
      const b = buckets.get(key) || { origin: r.origin, holder: r.holder, issued: 0, used: 0, lines: 0 };
      if (r.kind === 'issue') b.issued += r.sum; else b.used += r.sum;
      b.lines += 1;
      buckets.set(key, b);
    }
    const list = [...buckets.values()].sort((a, b) => (b.issued + b.used) - (a.issued + a.used));
    return {
      columns: [BUILDING_COL, 'Получатель / откуда', 'Движений', 'Выдано со склада (себестоимость)', 'Списано на пациентов (себестоимость)'],
      rows: list.map((b) => [ctx.label(b.origin), b.holder, b.lines, round2(b.issued), round2(b.used)]),
      by_building: summariseByBuilding(ctx, list, { total: (b) => b.issued + b.used }),
      total_label: 'Себестоимость',
      notes,
    };
  }
  if (by === 'patient') {
    const buckets = new Map();
    for (const r of mv) {
      if (r.kind === 'issue') continue;
      const key = ctx.keyOf(r.origin) + '\u0000' + (r.patient_id == null ? '' : r.patient_id);
      const b = buckets.get(key) || { origin: r.origin, patient: r.patient || 'Пациент не определён', lines: 0, sum: 0 };
      b.lines += 1; b.sum += r.sum;
      buckets.set(key, b);
    }
    const list = [...buckets.values()].sort((a, b) => b.sum - a.sum);
    return {
      columns: [BUILDING_COL, 'Пациент', 'Движений', 'Списано (себестоимость)'],
      rows: list.map((b) => [ctx.label(b.origin), b.patient, b.lines, round2(b.sum)]),
      by_building: summariseByBuilding(ctx, list, { total: (b) => b.sum }),
      total_label: 'Себестоимость',
      notes: [...notes, 'Строка визита, удалённая вместе с отменой расхода, пациента уже не называет: такие движения собраны под «Пациент не определён» и в сумме гасят друг друга.'],
    };
  }
  return {
    columns: [BUILDING_COL, 'Дата', 'Вид', 'Товар', 'Кол-во', 'Ед.', 'Себестоимость ед.', 'Сумма',
              'Получатель / откуда', 'Пациент', 'Кто провёл'],
    rows: mv.map((r) => [ctx.label(r.origin), r.date, CONSUMPTION_KIND_RU[r.kind], r.product, round2(r.qty), r.unit || '',
      round2(r.cost), round2(r.sum), r.holder, r.patient || '', r.actor || '']),
    by_building: summariseByBuilding(ctx, mv, { total: (r) => r.sum }),
    total_label: 'Себестоимость',
    notes,
  };
}

// (в) ВЕДОМОСТЬ ОСТАТКОВ СКЛАДА за период, по товару:
//   начало + приход − выдано − списано на пациентов ± корректировки = конец,
// количеством и деньгами. Остаток склада (products.on_hand) двигают ровно эти
// движения журнала: всё, у чего нет держателя (приход, корректировка,
// инвентаризация, списание и отмена со склада), плюс выдача со склада
// получателю (issue / requisition — держатель это КОМУ, а не откуда). Расход
// из подотчёта, кабинета и отдела остаток склада НЕ трогает (HOLDINGS_V1) и
// сюда не входит.
//
// ДЕНЬГИ — ПО СРЕДНЕЙ ЦЕНЕ ТОВАРА НА СЕГОДНЯ (products.avg_cost) для всех
// колонок сразу: только так «начало + приход − расход = конец» держится и в
// деньгах. Фактическая цена прихода — в виде «Приход по поставщикам».
//
// СВЕРКА: период, который кончается сегодня (или позже), обязан кончаться
// остатком из карточки товара. Не сошлось — значит остаток правили мимо
// журнала, и ведомость это называет, а не прячет.
const WAREHOUSE_LEDGER_SQL = `(m.holder_type IS NULL OR m.reference_type IN ('issue', 'requisition'))`;
const STATEMENT_NOTE = 'Деньги — по средней себестоимости товара на сегодня (одна цена на все колонки, чтобы начало + приход − расход = конец сходилось и в сумах). Фактические цены прихода — в виде «Приход по поставщикам». Расход из подотчёта, кабинетов и отделов остаток склада не меняет — он уже ушёл со склада выдачей.';

function stockStatementReport(db, args, ctx) {
  const { from, to } = resolveRange(db, args);
  const gf = buildingWhere(db, ctx, args, 'stock_movements', 'm');
  if (gf.clause.includes('1 = 0')) {
    return { columns: statementColumns(false), rows: [], by_building: summariseByBuilding(ctx, [], {}), total_label: 'Конец: сумма', notes: [STOCK_LOCAL_NOTE] };
  }
  const day = `${localDate('m.created_at')}`;
  const rows = db.prepare(`
    SELECT pr.id, pr.name, COALESCE(pr.code, '') AS code, ${STOCK_UNIT_SQL} AS unit,
           COALESCE(pr.avg_cost, 0) AS avg_cost, COALESCE(pr.on_hand, 0) AS on_hand,
           COALESCE(SUM(CASE WHEN ${day} < date(?) THEN m.qty END), 0) AS opening,
           COALESCE(SUM(CASE WHEN ${day} BETWEEN date(?) AND date(?) AND m.kind = 'receive' THEN m.qty END), 0) AS received,
           COALESCE(SUM(CASE WHEN ${day} BETWEEN date(?) AND date(?) AND m.kind = 'dispense'
                              AND m.reference_type IN ('issue', 'requisition') THEN -m.qty END), 0) AS issued,
           COALESCE(SUM(CASE WHEN ${day} BETWEEN date(?) AND date(?) AND m.kind IN ('dispense', 'void')
                              AND COALESCE(m.reference_type, '') NOT IN ('issue', 'requisition') THEN -m.qty END), 0) AS used,
           COALESCE(SUM(CASE WHEN ${day} BETWEEN date(?) AND date(?)
                              AND m.kind NOT IN ('receive', 'dispense', 'void') THEN m.qty END), 0) AS adjusted,
           COUNT(m.id) AS movements
      FROM products pr
      LEFT JOIN stock_movements m ON m.product_id = pr.id AND ${WAREHOUSE_LEDGER_SQL}
                                 AND ${day} <= date(?)
     GROUP BY pr.id
     HAVING movements > 0 OR pr.on_hand <> 0
     ORDER BY pr.name, pr.id
  `).all(from, from, to, from, to, from, to, from, to, to);
  const checkNow = String(to).slice(0, 10) >= today(db);
  const list = rows.map((r) => {
    const closing = round2(r.opening + r.received - r.issued - r.used + r.adjusted);
    return { ...r, closing, diff: round2(closing - r.on_hand) };
  }).filter((r) => r.opening || r.received || r.issued || r.used || r.adjusted || r.closing || (checkNow && r.on_hand));
  const notes = [STOCK_LOCAL_NOTE, STATEMENT_NOTE];
  if (checkNow) {
    const bad = list.filter((r) => Math.abs(r.diff) > 1e-6);
    notes.push(bad.length
      ? 'Сверка с карточкой товара: у ' + bad.length + ' ' + pluralRu(bad.length, 'товара', 'товаров', 'товаров')
        + ' конечный остаток не совпадает с остатком в карточке — остаток меняли мимо журнала движений (колонка «Расхождение»).'
      : 'Сверка с карточкой товара: конечный остаток совпадает с остатком в карточке у всех товаров.');
  }
  const money = (q, r) => round2(q * r.avg_cost);
  return {
    columns: statementColumns(checkNow),
    rows: list.map((r) => {
      const row = [ctx.label(''), r.name, r.code, r.unit || '',
        round2(r.opening), round2(r.received), round2(r.issued), round2(r.used), round2(r.adjusted), r.closing,
        round2(r.avg_cost),
        money(r.opening, r), money(r.received, r), money(r.issued, r), money(r.used, r), money(r.adjusted, r), money(r.closing, r)];
      if (checkNow) row.push(round2(r.on_hand), r.diff);
      return row;
    }),
    by_building: summariseByBuilding(ctx, list.map((r) => ({ origin: '', value: r.closing * r.avg_cost })), { total: (r) => r.value }),
    total_label: 'Конец: сумма',
    notes,
  };
}
function statementColumns(checkNow) {
  const cols = [BUILDING_COL, 'Товар', 'Код', 'Ед.',
    'Начало: кол-во', 'Приход: кол-во', 'Выдано: кол-во', 'Списано на пациентов: кол-во', 'Корректировки: кол-во', 'Конец: кол-во',
    'Средняя себестоимость',
    'Начало: сумма', 'Приход: сумма', 'Выдано: сумма', 'Списано на пациентов: сумма', 'Корректировки: сумма', 'Конец: сумма'];
  if (checkNow) cols.push('В карточке товара', 'Расхождение');
  return cols;
}

// (г) ПРОСРОЧЕННОЕ И ИСТЕКАЮЩЕЕ — с ценой. Партии и их остатки считает тот же
// расклад, что экран «Сроки годности» (EXPIRY_BALANCE_V1, rpc/expiry.js
// lotBalances: остаток склада раскладывается по приходам, самый поздний
// приход первым). Это РАСЧЁТ, а не измерение: расход партию не пишет, — и
// отчёт говорит это теми же словами, что экран. Снимок на сегодня: период
// отчёта здесь не участвует.
const EXPIRY_STATE_RU = { expired: 'Просрочено', soon: 'Истекает' };
const EXPIRY_NOTE = 'Остаток по партиям — расчёт, а не факт: программа не запоминает, из какой партии товар взяли, и считает, что первым расходуется ближайший срок. Стоимость — по средней себестоимости товара.';

function stockExpiryReport(db, args, ctx) {
  const gf = buildingWhere(db, ctx, args, 'stock_movements', 'm');
  const day = today(db);
  const snapNote = 'Снимок на сегодня (' + day + '): период отчёта здесь не участвует. «Истекает» — срок в ближайшие ' + EXPIRING_SOON_DAYS + ' дней.';
  if (gf.clause.includes('1 = 0')) {
    return { columns: expiryColumns(), rows: [], by_building: summariseByBuilding(ctx, [], {}), total_label: 'Стоимость', notes: [STOCK_LOCAL_NOTE, EXPIRY_NOTE, snapNote] };
  }
  const cost = new Map(db.prepare('SELECT id, COALESCE(avg_cost, 0) AS avg_cost FROM products').all().map((p) => [p.id, p.avg_cost]));
  const lots = lotBalances(db, { todayStr: day })
    .filter((l) => (l.state === 'expired' || l.state === 'soon') && l.remaining > 1e-9)
    .sort((a, b) => (a.state === b.state ? (a.expiry_date < b.expiry_date ? -1 : a.expiry_date > b.expiry_date ? 1 : 0) : (a.state === 'expired' ? -1 : 1)));
  const list = lots.map((l) => ({ ...l, origin: '', cost: cost.get(l.product_id) || 0, value: l.remaining * (cost.get(l.product_id) || 0) }));
  return {
    columns: expiryColumns(),
    rows: list.map((l) => [ctx.label(''), EXPIRY_STATE_RU[l.state], l.product_name, l.product_code || '', l.batch_no || '',
      l.expiry_date, l.days_left, round2(l.remaining), l.unit || '', round2(l.cost), round2(l.value), l.supplier_name || '']),
    by_building: summariseByBuilding(ctx, list, { total: (l) => l.value }),
    total_label: 'Стоимость',
    notes: [STOCK_LOCAL_NOTE, EXPIRY_NOTE, snapNote],
  };
}
function expiryColumns() {
  return [BUILDING_COL, 'Состояние', 'Товар', 'Код', 'Партия', 'Срок годности', 'Дней до срока',
          'Остаток (расчёт)', 'Ед.', 'Средняя себестоимость', 'Стоимость', 'Поставщик'];
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
  // INPATIENT_SHARE_V1 — строки стационара идут СВОИМИ колонками. Амбулаторные
  // колонки считают только амбулаторные строки (ias пуст) — ровно то, что они
  // считали до стационарной доли, поэтому их числа не сдвинулись ни на сум.
  // «Итого к выплате» = амбулаторная доля + стационарная.
  const OUT = 'ias.id IS NULL';
  const rows = db.prepare(`
    SELECT ${originExpr(db, 'invoices', 'i')} AS origin,
           COALESCE(doc.full_name, idoc.full_name) AS doctor,
           SUM(CASE WHEN ${OUT} THEN 1 ELSE 0 END) AS services_count,
           COALESCE(SUM(CASE WHEN ${OUT} THEN ii.total - ${ITEM_DISCOUNT_SQL} END), 0) AS after_discount,
           -- DOCTOR_FIX_RATE_V1 — averaged over the PERCENTAGE lines only; a
           -- fixed-rate line has no percentage, and folding it in as 0 would
           -- drag the average down and misreport the doctor's terms.
           -- DOCTOR_TIER_V1 — усредняется ДЕЙСТВУЮЩИЙ процент: иначе средний %
           -- в отчёте не сходился бы с гонораром, посчитанным со ступенью.
           AVG(CASE WHEN ${OUT} AND ${ITEM_FIX_SQL} IS NULL THEN ${ITEM_EFF_PCT_SQL} END) AS avg_pct,
           SUM(CASE WHEN ${OUT} AND ${ITEM_FIX_SQL} IS NOT NULL THEN 1 ELSE 0 END) AS fixed_lines,
           COALESCE(SUM(CASE WHEN ${OUT} THEN ${ITEM_FEE_SQL} END), 0) AS fee,
           SUM(CASE WHEN ias.id IS NOT NULL THEN 1 ELSE 0 END) AS in_count,
           COALESCE(SUM(CASE WHEN ias.id IS NOT NULL THEN ii.total - ${ITEM_DISCOUNT_SQL} END), 0) AS in_after_discount,
           COALESCE(SUM(CASE WHEN ias.id IS NOT NULL THEN ${INPATIENT_FEE_SQL} END), 0) AS in_fee,
           SUM(CASE WHEN ias.id IS NOT NULL AND idr.inpatient_pct IS NULL THEN 1 ELSE 0 END) AS in_norate
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      ${ITEM_DOCTOR_JOIN}
     WHERE i.status = 'paid'
       AND (vs.doctor_id IS NOT NULL OR ias.id IS NOT NULL${foreignKeep})
       AND ${inLocalRange('i.created_at')}${bf.clause}${gf.clause}
     GROUP BY origin, ${LINE_DOCTOR_ID_SQL}
     ORDER BY origin, after_discount + in_after_discount DESC
  `).all(from, to, ...bf.params, ...gf.params)
    // Ревью I1 (владелец: доля остаётся нулём, но об этом сказано): человек,
    // у которого в периоде только строки стационара БЕЗ его стационарной ставки
    // (медсестра нажала «Выполнить»), не показывается нулевой строкой — он
    // назван в примечании вместе с числом таких услуг.
    .filter((r) => !(r.services_count === 0 && r.in_count > 0 && r.in_norate === r.in_count));
  const noRate = inpatientNoRateNote(db, { from, to, bf, gf });
  return {
    columns: [BUILDING_COL, 'Врач', 'Оплаченных услуг', 'Сумма после скидки', 'Средний % врача',
              'Услуг по фикс. ставке', 'Доля врача (гонорар)',
              'Стационар: услуг', 'Стационар: сумма после скидки', 'Стационар: гонорар', 'Итого к выплате'],
    // avg_pct is NULL when every line was fixed-rate — print '—' rather than 0,
    // which would claim the doctor works for nothing.
    rows: rows.map((r) => [ctx.label(r.origin), doctorCell(ctx, r) || '—', r.services_count,
      round2(r.after_discount),
      r.avg_pct == null ? '—' : round2(r.avg_pct), r.fixed_lines || 0, round2(r.fee),
      r.in_count || 0, round2(r.in_after_discount), round2(r.in_fee), round2(r.fee + r.in_fee)]),
    by_building: summariseByBuilding(ctx, rows, {
      total: (r) => (r.after_discount || 0) + (r.in_after_discount || 0),
      fee: (r) => (r.fee || 0) + (r.in_fee || 0),
    }),
    total_label: 'Сумма после скидки',
    notes: [...(hasUnattributed(ctx, rows) ? [UNATTRIBUTED_NOTE] : []), ...(noRate ? [noRate] : [])],
  };
}

// INPATIENT_SHARE_V1 — оплаченные медицинские строки стационара с врачом,
// ставкой и начисленной долей. ОДИН запрос на отчёт «Стационар: доля врачей»
// и на кабинет врача (doctorInpatientShare): две выборки одной выплаты
// разошлись бы молча. Период — по дате СЧЁТА (i.created_at), как у «Зарплат
// врачей»; оплачен ли — по статусу счёта 'paid', как там же. Строки, у которых
// есть амбулаторный врач (visit_services), сюда не входят — их доля считается
// амбулаторной (та же развилка, что в ITEM_DOCTOR_JOIN).
function inpatientShareRows(db, { from, to, doctorId = null, bf = { clause: '', params: [] }, gf = { clause: '', params: [] } }) {
  const docClause = doctorId != null ? ` AND ${INPATIENT_DOCTOR_SQL} = ?` : '';
  return db.prepare(`
    SELECT ${originExpr(db, 'invoices', 'i')}  AS origin,
           ${localDate('i.created_at')}       AS date,
           i.invoice_number                   AS invoice,
           pt.full_name                       AS patient,
           COALESCE(NULLIF(a.admission_no, ''), CAST(ias.admission_id AS TEXT)) AS admission_no,
           COALESCE(s.name, ii.description)   AS service,
           ii.quantity                        AS qty,
           ii.total                           AS amount,
           ${ITEM_DISCOUNT_SQL}               AS discount,
           ${ITEM_TAX_SQL}                    AS tax,
           ${ITEM_NET_SQL}                    AS net,
           ${INPATIENT_DOCTOR_SQL}            AS doctor_id,
           idoc.full_name                     AS doctor,
           CASE WHEN ias.performer_id IS NOT NULL THEN 'performer' ELSE 'ordering' END AS doctor_role,
           idr.inpatient_pct                  AS pct,
           ${INPATIENT_FEE_SQL}               AS fee
      FROM invoice_items ii
      JOIN invoices i  ON i.id = ii.invoice_id
      JOIN admission_services ias ON ias.id = ${INPATIENT_LINE_PICK_SQL}
      LEFT JOIN admissions a ON a.id = ias.admission_id
      LEFT JOIN patients pt  ON pt.id = i.patient_id
      LEFT JOIN services s   ON s.id = ii.service_id
      LEFT JOIN users idoc   ON idoc.id = ${INPATIENT_DOCTOR_SQL}
      LEFT JOIN (${INPATIENT_RATE_SQL}) idr ON idr.doctor_id = ${INPATIENT_DOCTOR_SQL}
                                           AND idr.service_id = ii.service_id
      -- Ревью C1: «у строки счёта нет амбулаторного врача» — сгруппированным
      -- LEFT JOIN, как в ITEM_DOCTOR_JOIN, а не коррелированным NOT EXISTS по
      -- неиндексированной колонке (полный проход visit_services на каждую
      -- строку счёта: 51 тысяча строк — 39 с, кабинет врача — при каждом
      -- открытии). Индекс — миграция 149.
      LEFT JOIN (SELECT invoice_item_id FROM visit_services
                  WHERE invoice_item_id IS NOT NULL AND doctor_id IS NOT NULL
                  GROUP BY invoice_item_id) ovs ON ovs.invoice_item_id = ii.id
     WHERE i.status = 'paid'
       AND ovs.invoice_item_id IS NULL
       AND ${inLocalRange('i.created_at')}${docClause}${bf.clause}${gf.clause}
     ORDER BY origin, i.created_at, ii.id
  `).all(from, to, ...(doctorId != null ? [doctorId] : []), ...bf.params, ...gf.params);
}

const INPATIENT_ROLE_RU = { performer: 'Исполнитель', ordering: 'Назначил' };

// Ревью I1 — оплаченные строки стационара, у исполнителя которых (иначе у
// назначившего) нет стационарной ставки на эту услугу: доля по ним не
// начислена НИКОМУ (решение владельца — так и оставить, но сказать). Одна
// строка примечания на три отчёта: «Стационар: доля врачей», «Зарплаты
// врачей», «По врачам». Считается тем же запросом, что сама доля.
function inpatientNoRateNote(db, { from, to, bf, gf }) {
  const lines = inpatientShareRows(db, { from, to, bf, gf }).filter((r) => r.pct == null);
  if (!lines.length) return null;
  const who = new Map();
  for (const r of lines) who.set(r.doctor || '—', (who.get(r.doctor || '—') || 0) + 1);
  const list = [...who.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => n + ' — ' + c).join(', ');
  return lines.length + ' ' + pluralRu(lines.length, 'услуга', 'услуги', 'услуг')
    + ': исполнитель без стационарной ставки — доля не начислена (' + list + ').';
}

// Ревью I2 (владелец: исполнителя можно менять и после счёта) — отчёт идёт по
// ТЕКУЩЕМУ исполнителю строки.
const INPATIENT_CURRENT_PERFORMER_NOTE = 'Доля считается по текущему исполнителю строки: если исполнителя поменять после выставления счёта, доля перейдёт к новому.';

function inpatientShareReport(db, args, ctx) {
  const { from, to } = resolveRange(db, args);
  const bf = branchFilter(args, 'i.branch_id');
  const gf = buildingWhere(db, ctx, args, 'invoices', 'i');
  const src = inpatientShareRows(db, { from, to, bf, gf });
  const noRate = inpatientNoRateNote(db, { from, to, bf, gf });
  // Итоги по врачам — примечаниями над таблицей, по убыванию начисленного:
  // строка-подытог внутри таблицы попала бы и в общее «Итого» под ней.
  const perDoctor = new Map();
  for (const r of src) {
    const key = r.doctor_id;
    const d = perDoctor.get(key) || { doctor: r.doctor || '—', lines: 0, net: 0, fee: 0 };
    d.lines += 1; d.net += r.net; d.fee += r.fee;
    perDoctor.set(key, d);
  }
  const totals = [...perDoctor.values()].sort((a, b) => b.fee - a.fee || b.net - a.net)
    .map((d) => 'Итого — ' + d.doctor + ': ' + d.lines + ' '
      + pluralRu(d.lines, 'строка', 'строки', 'строк') + ', после скидки и налога '
      + moneyRu(d.net) + ' сум, начислено ' + moneyRu(d.fee) + ' сум.');
  return {
    columns: [BUILDING_COL, 'Дата', '№ счёта', 'Пациент', '№ госпитализации', 'Услуга', 'Кол-во', 'Сумма',
              'Скидка', 'Налог', 'После скидки и налога', 'Врач', 'Чей врач', 'Ставка, %', 'Начислено врачу'],
    rows: src.map((r) => [ctx.label(r.origin), r.date, r.invoice || '', r.patient || '', r.admission_no || '',
      r.service || '', r.qty, round2(r.amount), round2(r.discount), round2(r.tax), round2(r.net),
      r.doctor || '—', INPATIENT_ROLE_RU[r.doctor_role],
      // Нет стационарной доли на услугу — прочерк, а не «0 %»: ноль читался бы
      // как решение клиники, а это отсутствие решения.
      r.pct == null ? '—' : round2(r.pct), round2(r.fee)]),
    by_building: summariseByBuilding(ctx, src, {
      total: (r) => r.net || 0,
      fee: (r) => r.fee || 0,
    }),
    total_label: 'После скидки и налога',
    notes: [...totals, ...(noRate ? [noRate] : []), INPATIENT_CURRENT_PERFORMER_NOTE],
  };
}

// INPATIENT_SHARE_V1 — стационарная часть зарплаты для кабинета врача. Кабинет
// считает амбулаторную долю сам (serviceShare), а стационарную получает ГОТОВОЙ
// отсюда — тем же запросом, что и отчёт, без второй копии SQL в браузере.
// Ревью I6: свои начисления — врачу, чужие — «Отчётам» и администратору.
export function doctorInpatientShare(db, args, user) {
  const doctorId = Number(args && args.doctor_id);
  if (!Number.isInteger(doctorId) || doctorId <= 0) throw new RpcError('doctor_id must be a positive integer.', 400);
  assertCanSeeDoctorPay(db, user, doctorId);   // ревью I6
  const { from, to } = resolveRange(db, args);
  const rows = inpatientShareRows(db, { from, to, doctorId }).map((r) => ({
    date: r.date, invoice: r.invoice, patient: r.patient, admission_no: r.admission_no,
    service: r.service, qty: r.qty, net: round2(r.net), pct: r.pct == null ? null : round2(r.pct),
    fee: round2(r.fee), doctor_role: r.doctor_role,
  }));
  return {
    from, to, rows,
    count: rows.length,
    fee: round2(rows.reduce((n, r) => n + r.fee, 0)),
  };
}

// ---------------------------------------------------------------------------
// REPORTS_V2 — «По услугам» (kind 'by_services').
//
// Строка на услугу и место оказания (амбулатория / стационар — одна колонка
// «Где», а не два набора денежных колонок: так таблица читается слева
// направо и итог внизу складывает всё сразу). Деньги — ТЕ ЖЕ выражения, что в
// «Общей выручке» и «Зарплатах врачей» (itemRowsQuery: ITEM_DISCOUNT_SQL,
// ITEM_TAX_SQL, ITEM_NET_SQL, LINE_FEE_SQL), поэтому:
//   «Все счета»        — «Доля врача» = «Доля врача» «Общей выручки»;
//   «Только оплаченные» — «Доля врача» = «Итого к выплате» «Зарплат врачей».
// Аннулированные счета не входят (прежний отчёт 'services' их считал — он не
// используется). Период — по дате счёта.
// ---------------------------------------------------------------------------
const PAID_SCOPES = ['all', 'paid'];
function paidScope(args) {
  const v = args && args.paid;
  if (v === undefined || v === null || v === '') return 'all';
  if (!PAID_SCOPES.includes(v)) throw new RpcError('paid must be one of: all, paid.', 400);
  return v;
}
// Группа — одна из пяти (services.type), подписью раздела каталога
// (shared/service-categories.js): тот же словарь, что у мастера записи.
const SERVICE_GROUPS = ['consultation', 'lab', 'imaging', 'procedure', 'other'];
function groupFilter(args) {
  const v = args && args.group;
  if (v === undefined || v === null || v === '' || v === 'all') return null;
  if (!SERVICE_GROUPS.includes(v)) throw new RpcError('group must be one of: all, ' + SERVICE_GROUPS.join(', ') + '.', 400);
  return categoryOf({ type: v });
}
const lineGroup = (r) => (r.service_id == null && !r.service_group
  ? 'Прочее'
  : categoryOf({ type: r.service_group, is_lab: r.service_is_lab, name: r.service }));
const isInpatientLine = (r) => r.inpatient_line_id != null || r.admission_id != null;
const WHERE_RU = { out: 'Амбулатория', in: 'Стационар' };

const SHARE_ACCRUAL_NOTE = 'Доля врача начисляется после оплаты счёта. В режиме «Все счета» показано, сколько причитается по всем строкам, включая ещё не оплаченные; «Только оплаченные» сходится с «Зарплатами врачей».';

function byServicesReport(db, args, ctx) {
  const scope = paidScope(args);
  const group = groupFilter(args);
  const src = itemRowsQuery(db, args, ctx)
    .filter((r) => scope === 'all' || r.status === 'paid')
    .filter((r) => !group || lineGroup(r) === group);
  const buckets = new Map();
  for (const r of src) {
    const where = isInpatientLine(r) ? 'in' : 'out';
    const who = r.service_id != null ? 'id:' + r.service_id : 'nm:' + (r.service || '');
    const key = ctx.keyOf(r.origin) + '\u0000' + who + '\u0000' + where;
    const b = buckets.get(key) || {
      origin: r.origin, group: lineGroup(r), service: r.service || '—', where,
      qty: 0, gross: 0, discount: 0, tax: 0, net: 0, fee: 0, paid: 0,
    };
    b.qty += Number(r.qty) || 1;
    b.gross += r.amount || 0;
    b.discount += r.discount || 0;
    b.tax += r.tax || 0;
    b.net += r.net || 0;
    b.fee += r.doctor_fee || 0;
    if (r.status === 'paid') b.paid += (r.amount || 0) - (r.discount || 0);
    buckets.set(key, b);
  }
  const order = (g) => { const i = CAT_ORDER.indexOf(g); return i < 0 ? CAT_ORDER.length : i; };
  const list = [...buckets.values()].sort((a, b) =>
    (ctx.keyOf(a.origin) < ctx.keyOf(b.origin) ? -1 : ctx.keyOf(a.origin) > ctx.keyOf(b.origin) ? 1 : 0)
    || order(a.group) - order(b.group) || b.gross - a.gross);
  const notes = [SHARE_ACCRUAL_NOTE];
  if (hasUnattributed(ctx, src)) notes.push(UNATTRIBUTED_NOTE);
  return {
    columns: [BUILDING_COL, 'Группа', 'Услуга', 'Где', 'Кол-во', 'Сумма', 'Скидка', 'Налог',
              'После скидки и налога', 'Доля врача', 'Остаток клинике', 'Оплачено'],
    rows: list.map((b) => [ctx.label(b.origin), b.group, b.service, WHERE_RU[b.where], round2(b.qty),
      round2(b.gross), round2(b.discount), round2(b.tax), round2(b.net), round2(b.fee),
      round2(b.net - b.fee), round2(b.paid)]),
    by_building: summariseByBuilding(ctx, list, { total: (b) => b.gross - b.discount, fee: (b) => b.fee }),
    total_label: 'Сумма после скидки',
    notes,
  };
}

// ---------------------------------------------------------------------------
// REPORTS_V2 — «По врачам»: и выплата, и работа (kind 'by_doctors') плюс
// разбивка врача по услугам (kind 'doctor_services').
//
// Строки — те же, что у «Зарплат врачей» (itemRowsQuery: врач строки — врач
// visit_services, у стационара — исполнитель, иначе назначивший; доля —
// LINE_FEE_SQL). Работа (пациенты, визиты, услуги, выставлено) считается по
// ВСЕМ неаннулированным счетам периода; выплата (доли) — только по
// оплаченным, ровно как в «Зарплатах врачей», поэтому колонки долей в сумме
// равны им бит в бит. К выплате добавляется вознаграждение врача как
// НАПРАВИВШЕГО (его внутренний источник, referralLines — то же, что отчёт
// «Рефералы»). Период — по дате счёта.
// ---------------------------------------------------------------------------
const DOCTOR_PAY_NOTE = 'Работа (пациенты, визиты, услуги, выставлено) — по всем неаннулированным счетам периода; доли врача — только по оплаченным счетам, как в «Зарплатах врачей». «Вознаграждение за направления» — по внутреннему источнику врача, как в отчёте «Рефералы».';

// Строки врача: своя строка без врача не входит (как в «Зарплатах врачей»),
// строка соседнего здания без врача — входит под подписью здания.
function doctorLines(db, args, ctx) {
  const lines = itemRowsQuery(db, args, ctx)
    .filter((r) => r.doctor_id != null || ctx.keyOf(r.origin) !== ctx.ownKey);
  // Ревью I1 — тот, у кого в периоде только оплаченные строки стационара без
  // его стационарной ставки (медсестра нажала «Выполнить»), нулевой строкой не
  // показывается: он назван в примечании (inpatientNoRateNote), как в
  // «Зарплатах врачей».
  const noRateOnly = (r) => r.inpatient_line_id != null && r.inpatient_pct == null;
  const keep = new Set();
  for (const r of lines) if (!noRateOnly(r)) keep.add(doctorKey(ctx, r.origin, r.doctor_id));
  return lines.filter((r) => keep.has(doctorKey(ctx, r.origin, r.doctor_id)));
}
function doctorNotes(db, args, ctx, lines) {
  const { from, to } = resolveRange(db, args);
  const noRate = inpatientNoRateNote(db, { from, to, bf: branchFilter(args, 'i.branch_id'), gf: buildingWhere(db, ctx, args, 'invoices', 'i') });
  const notes = [DOCTOR_PAY_NOTE];
  if (hasUnattributed(ctx, lines)) notes.push(UNATTRIBUTED_NOTE);
  if (noRate) notes.push(noRate);
  return notes;
}
const doctorKey = (ctx, origin, doctorId) => ctx.keyOf(origin) + '\u0000' + (doctorId == null ? '' : doctorId);

function byDoctorsReport(db, args, ctx) {
  const lines = doctorLines(db, args, ctx);
  const names = new Map(db.prepare('SELECT id, full_name, username FROM users').all()
    .map((u) => [u.id, u.full_name || u.username]));
  const buckets = new Map();
  const bucket = (origin, doctorId, doctor) => {
    const key = doctorKey(ctx, origin, doctorId);
    if (!buckets.has(key)) {
      buckets.set(key, {
        origin, doctor_id: doctorId, doctor: doctor || (doctorId != null ? names.get(doctorId) : null) || null,
        patients: new Set(), visits: new Set(), admissions: new Set(), count: 0,
        billed: 0, paid: 0, fee_out: 0, fee_in: 0, referral: 0,
      });
    }
    return buckets.get(key);
  };
  for (const r of lines) {
    const b = bucket(r.origin, r.doctor_id, r.doctor);
    const after = (r.amount || 0) - (r.discount || 0);
    b.patients.add(r.patient_id);
    if (r.inpatient_line_id != null) { if (r.admission_id != null) b.admissions.add(r.admission_id); }
    else if (r.visit_id != null) b.visits.add(r.visit_id);
    b.count += 1;
    b.billed += after;
    if (r.status === 'paid') {
      b.paid += after;
      if (r.inpatient_line_id != null) b.fee_in += r.doctor_fee || 0;
      else b.fee_out += r.doctor_fee || 0;
    }
  }
  // Вознаграждение врача как направившего — только у внутренних источников,
  // связанных с сотрудником. Врач, который в периоде сам ничего не оказал, но
  // направлял, тоже получает строку: ему есть что платить.
  for (const r of referralLines(db, { ...args, referrer: 'all' }, ctx)) {
    if (r.referral_doctor_id == null || !r.reward) continue;
    bucket(r.origin, r.referral_doctor_id, null).referral += r.reward;
  }
  const list = [...buckets.values()].sort((a, b) =>
    (ctx.keyOf(a.origin) < ctx.keyOf(b.origin) ? -1 : ctx.keyOf(a.origin) > ctx.keyOf(b.origin) ? 1 : 0)
    || (b.fee_out + b.fee_in + b.referral) - (a.fee_out + a.fee_in + a.referral) || b.billed - a.billed);
  const notes = doctorNotes(db, args, ctx, lines);
  return {
    columns: [BUILDING_COL, 'Врач', 'Пациентов', 'Визитов', 'Госпитализаций', 'Услуг', 'Выставлено',
              'Оплачено', 'Доля за услуги', 'Стационарная доля', 'Вознаграждение за направления', 'Итого к выплате'],
    rows: list.map((b) => [ctx.label(b.origin), doctorCell(ctx, b) || '—', b.patients.size, b.visits.size,
      b.admissions.size, b.count, round2(b.billed), round2(b.paid), round2(b.fee_out), round2(b.fee_in),
      round2(b.referral), round2(b.fee_out + b.fee_in + b.referral)]),
    by_building: summariseByBuilding(ctx, list, {
      total: (b) => b.billed,
      fee: (b) => b.fee_out + b.fee_in + b.referral,
    }),
    total_label: 'Выставлено',
    notes,
  };
}

// Разбивка: врач × услуга × место. Сумма «Доля врача» по врачу равна «Доле за
// услуги» + «Стационарной доле» его строки в 'by_doctors'.
function doctorServicesReport(db, args, ctx) {
  const lines = doctorLines(db, args, ctx);
  const buckets = new Map();
  for (const r of lines) {
    const where = r.inpatient_line_id != null ? 'in' : 'out';
    const who = r.service_id != null ? 'id:' + r.service_id : 'nm:' + (r.service || '');
    const key = doctorKey(ctx, r.origin, r.doctor_id) + '\u0000' + who + '\u0000' + where;
    const b = buckets.get(key) || {
      origin: r.origin, doctor: r.doctor, service: r.service || '—', where,
      patients: new Set(), qty: 0, billed: 0, paid: 0, fee: 0,
    };
    const after = (r.amount || 0) - (r.discount || 0);
    b.patients.add(r.patient_id);
    b.qty += Number(r.qty) || 1;
    b.billed += after;
    if (r.status === 'paid') { b.paid += after; b.fee += r.doctor_fee || 0; }
    buckets.set(key, b);
  }
  const list = [...buckets.values()].sort((a, b) =>
    (ctx.keyOf(a.origin) < ctx.keyOf(b.origin) ? -1 : ctx.keyOf(a.origin) > ctx.keyOf(b.origin) ? 1 : 0)
    || String(a.doctor || '').localeCompare(String(b.doctor || ''), 'ru') || b.billed - a.billed);
  const notes = doctorNotes(db, args, ctx, lines);
  return {
    columns: [BUILDING_COL, 'Врач', 'Услуга', 'Где', 'Пациентов', 'Кол-во', 'Выставлено', 'Оплачено', 'Доля врача'],
    rows: list.map((b) => [ctx.label(b.origin), doctorCell(ctx, b) || '—', b.service, WHERE_RU[b.where],
      b.patients.size, round2(b.qty), round2(b.billed), round2(b.paid), round2(b.fee)]),
    by_building: summariseByBuilding(ctx, list, { total: (b) => b.billed, fee: (b) => b.fee }),
    total_label: 'Выставлено',
    notes,
  };
}

const REPORTS_RU = {
  total_revenue:    totalRevenueReport,
  referrals:        referralsReport,
  invoices_full:    invoicesFullReport,
  procurement:      procurementReport,
  surgery_profit:   surgeryProfitReport,
  doctor_salaries:  doctorSalariesReport,
  inpatient_share:  inpatientShareReport,   // INPATIENT_SHARE_V1
  // REPORTS_V2 — детализация рефералов (сводка — 'referrals' выше).
  referrals_detail: referralsDetailReport,
  by_services:      byServicesReport,        // REPORTS_V2 — по услугам
  by_doctors:       byDoctorsReport,         // REPORTS_V2 — по врачам: выплата и работа
  doctor_services:  doctorServicesReport,    // REPORTS_V2 — врач × услуга
  // REPORTS_V2 — «Закупки и склад»: приход — 'procurement' выше.
  stock_consumption: stockConsumptionReport,
  stock_statement:   stockStatementReport,
  stock_expiry:      stockExpiryReport,
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
  'inpatient_share',   // INPATIENT_SHARE_V1 — тоже читает строки счетов
  'referrals_detail',  // REPORTS_V2 — те же строки счетов, что у сводки
  'by_services', 'by_doctors', 'doctor_services',   // REPORTS_V2
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

// DOCTOR_TIER_V1 — позиции строк врача за месяц 'YYYY-MM' ({ month }) или за
// диапазон месяцев ({ from, to }, оба 'YYYY-MM', включительно): кабинет получает
// ГОТОВУЮ нумерацию и не считает её сам — две нумерации разошлись бы молча,
// тот же довод, что у serviceShare/ITEM_FEE_SQL. Диапазон — чтобы кабинет за
// «12 месяцев» спрашивал ОДИН раз, а не звал RPC в цикле по месяцам; месяц
// строки едет в ответе (ym), и раскладывает строки по месяцам уже клиент.
// Читает любой вошедший, как и отчёты (шапка файла). Пусто — у врача в этих
// месяцах нет строк по услугам со ступенью.
const TIER_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export function doctorTierPositions(db, args, _user) {
  const doctorId = Number(args && args.doctor_id);
  if (!Number.isInteger(doctorId) || doctorId <= 0) throw new RpcError('doctor_id must be a positive integer.', 400);
  const month = args && args.month != null ? String(args.month) : '';
  const from = month ? month : String((args && args.from) || '');
  const to = month ? month : String((args && args.to) || '');
  if (!TIER_MONTH_RE.test(from) || !TIER_MONTH_RE.test(to)) {
    throw new RpcError('month must be YYYY-MM (or from/to as YYYY-MM).', 400);
  }
  if (from > to) throw new RpcError('from must not be after to.', 400);
  const rows = db.prepare(`
    SELECT t.visit_service_id, t.service_id, s.name AS service_name,
           t.ym,
           t.qty AS units,
           MAX(0, MIN(t.qty, t.running - t.tier_from)) AS units_above,
           -- DOCTOR_TIER_V2 — единицы за порогами 2 и 3 (0, если ступени нет).
           CASE WHEN t.tier_from_2 > 0 THEN MAX(0, MIN(t.qty, t.running - t.tier_from_2)) ELSE 0 END AS units_above_2,
           CASE WHEN t.tier_from_3 > 0 THEN MAX(0, MIN(t.qty, t.running - t.tier_from_3)) ELSE 0 END AS units_above_3,
           t.tier_from, t.tier_percent,
           t.tier_from_2, t.tier_percent_2, t.tier_from_3, t.tier_percent_3,
           t.running AS count_so_far
      FROM (${TIER_RANK_SQL}) t
      JOIN services s ON s.id = t.service_id
     WHERE t.doctor_id = ? AND t.ym BETWEEN ? AND ?
     ORDER BY t.ym, t.service_id, t.running, t.visit_service_id
  `).all(doctorId, from, to);
  // Форма { month } отвечает и month тоже: вызов одного месяца не обязан знать
  // про диапазон.
  return month ? { month, from, to, rows } : { from, to, rows };
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
