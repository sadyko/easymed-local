// Reporting RPCs — read-only. /api/db can't do SUM/GROUP BY/date-range
// filters on most tables, so both the period-overview KPIs and the tabular
// date-range reports are computed here from raw rows.
//
// ROLE_REPORTS_SETTINGS_V1 (2026-09-25) — КТО ЗОВЁТ, ТЕПЕРЬ ВАЖНО. Раньше
// здесь было «any authenticated user may call these»: раздел «Отчёты»
// закрывал только пункт меню. run_report и owner_report проверяют группу
// отчёта (services/report-access.js, карта REPORT_GROUP справочника прав);
// начисления врача в кабинете — «свои или „Оплата врачей“». Без ворот
// остаются reports_overview (дашборд), report_buildings и report_freshness —
// в них нет строк отчётов.

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
import { resolveReferralRate, rewardForLine, referralGroupOf } from '../../../public/js/shared/referral-reward.js';
// REPORTS_V2 — группа услуги (одна из пяти) подписью раздела каталога: тот же
// модуль, что раскладывает каталог в мастере записи.
import { categoryOf, CAT_ORDER } from '../../../public/js/shared/service-categories.js';
// REPORTS_V2 — отчёты склада: КОМУ и НА КОГО тем же SQL, что журнал движений,
// а партии и их остатки — тем же расчётом, что экран «Сроки годности».
import { holderNameSql, movementPatientSql } from './stock-log.js';
import { lotBalances, EXPIRING_SOON_DAYS, parseCategories, categoryClause } from './expiry.js';
// REPORTS_V2, ревью I6 — кто видит начисления врача: сам врач или тот, кому
// открыта группа «Оплата врачей» (ROLE_REPORTS_SETTINGS_V1; прежде — весь
// раздел «Отчёты»), и администратор.
import { canSeeReportKey, requireReportKind } from '../report-access.js';
// PAY_BASIS_PERFORMED_V1 — выполненная, но ещё не выставленная строка платит
// врачу с той цены и той скидки категории, которые поставит счёт: правило
// цены и правило скидки — у кассы, здесь только их вызов.
import { lineUnitPrice } from '../domain/pricing.js';
import { patientCategoryDiscount } from './billing.js';
// DOCTOR_LINES_SPECIALTY_V1 — «По специальностям» группирует тем же правилом,
// которым карточка сотрудника сохраняет специальность (старые имена → одно).
import { specialtyGroupName } from '../../../public/js/shared/specialty-list.js';

/**
 * Начисления врача (кабинет): свои — ВСЕГДА, и ни одна галочка «Отчётов» этого
 * не отнимает; чужие — администратору и тем, кому открыта группа отчётов
 * `keys` (по умолчанию «Оплата врачей»: ей и так видны все врачи в «Зарплатах
 * врачей»). Прежде любой вошедший мог спросить чужие деньги по номеру врача,
 * а после ревью I6 — любой, кому открыт хоть один отчёт (кассир ради кассы).
 */
function assertCanSeeDoctorPay(db, user, doctorId, keys = ['reports.doctor_pay']) {
  if (user && Number(user.id) === Number(doctorId)) return;
  if (user && keys.some((k) => canSeeReportKey(db, user, k))) return;
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

// PAY_BASIS_PERFORMED_V1 (владелец, 26.09) — ДОЛЯ ВРАЧА ПО ВЫПОЛНЕННЫМ УСЛУГАМ.
//
// «Кабинет врача считает амбулаторную выплату по выполненным услугам, отчёты —
// по оплаченным счетам, и суммы расходятся. Какую базу брать обоим?» —
// «Выполненные услуги, как кабинет сейчас», и отчёты переходят на неё. Одно
// определение на всю систему — здесь, и его читают и ступени (TIER_RANK_SQL),
// и выплата (performedPayLines), и признак «выполнена» у строк счёта в
// отчётах по выручке:
//
//   АМБУЛАТОРНАЯ строка (visit_services) выполнена, когда её статус —
//     collected (лаборатория взяла материал), in_progress, resulted или
//     completed; added и queued — ещё нет. Правило то же, по которому ступень
//     считала «начатые» строки с DOCTOR_TIER_V1. Визит отменён или «не
//     пришёл» — строка не считается.
//   СТАЦИОНАРНАЯ строка (admission_services) выполнена, когда стоит
//     performed_at — отметка «Выполнено» (procedures.js / admission-charges.js;
//     её status принадлежит кассе: buildAdmissionInvoice ставит 'completed'
//     при выставлении счёта, это не «сделано»). Строка «в учёт расходов»
//     (billable = 0) пациенту не выставляется и доли не даёт; отменённая
//     госпитализация — тоже.
//   ОТМЕНЁННЫЙ СЧЁТ: строка, привязанная к счёту 'void' или 'refunded', не
//     считается никогда — ни ступенью, ни выплатой.
//
// Вознаграждение ВНЕШНИХ партнёров за направления (referralLines) остаётся по
// ОПЛАЧЕННЫМ счетам: это деньги, уходящие из клиники, — решение владельца.
const VS_PERFORMED_STATUSES = ['collected', 'in_progress', 'resulted', 'completed'];
const VS_PERFORMED_SQL = (vs) => `${vs}.status IN (${VS_PERFORMED_STATUSES.map((x) => "'" + x + "'").join(', ')})`;
const LIVE_INVOICE_SQL = (i) => `(${i}.id IS NULL OR ${i}.status NOT IN ('void', 'refunded'))`;
const LIVE_VISIT_SQL = (v) => `COALESCE(${v}.status, '') NOT IN ('cancelled', 'no_show')`;
const OUT_PERFORMED_SQL = (vs, v, i) => `(${VS_PERFORMED_SQL(vs)} AND ${LIVE_VISIT_SQL(v)} AND ${LIVE_INVOICE_SQL(i)})`;
const IN_DONE_SQL = (as, a) => `(${as}.performed_at IS NOT NULL AND COALESCE(${as}.billable, 1) = 1
  AND COALESCE(${a}.status, '') <> 'cancelled')`;
// Медицинская строка стационара: услуга, не расходник и не койко-дни.
const IN_MEDICAL_SQL = (as) => `(${as}.service_id IS NOT NULL AND ${as}.clinic_item_id IS NULL
  AND COALESCE(${as}.notes, '') NOT LIKE 'ACCOMMODATION%'
  AND COALESCE(${as}.performer_id, ${as}.doctor_id) IS NOT NULL)`;
// Одна амбулаторная строка с врачом на строку счёта (как ITEM_DOCTOR_JOIN).
const VS_BY_ITEM_SQL = `SELECT invoice_item_id, MIN(id) AS first_id FROM visit_services
   WHERE invoice_item_id IS NOT NULL AND doctor_id IS NOT NULL GROUP BY invoice_item_id`;

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
         -- PAY_BASIS_PERFORMED_V1 — номер получает ВЫПОЛНЕННАЯ строка, ровно
         -- та, что платится (прежде — «оплачена ИЛИ начата»: оплаченная, но не
         -- начатая строка занимала номер, за который ещё никто не платил).
         AND ${OUT_PERFORMED_SQL('vs', 'v', 'tinv')}
    ) r
    JOIN services s ON s.id = r.service_id AND s.doctor_tier_from > 0
`;

// INPATIENT_SHARE_V1 — стационарная доля врача (владелец, 23.09): отдельный
// «Стационар, %» на каждую услугу в карточке сотрудника (с INPATIENT_BONUS_V1 —
// users.inpatient_rates, вкладка «Стационар», процент ИЛИ фикс за единицу;
// ниже «inpatient_pct» читать как «стационарная ставка»). Правило:
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
// Стационарная ставка из карточки: только если значение задано ЧИСЛОМ.
//
// INPATIENT_BONUS_V1 (мигр. 155) — ставки стационара живут ОТДЕЛЬНО от
// амбулаторных, в users.inpatient_rates ([{service_id, pct} | {service_id,
// fix}], вкладка «Стационар» карточки сотрудника); ключа inpatient_pct в
// service_rates больше нет. Ставка — процент ЛИБО фиксированная сумма за
// единицу (fix): фикс, как у амбулаторной доли (DOCTOR_FIX_RATE_V1), налогом
// не режется и процент при нём не платится. Ставки нет — доля 0, как прежде.
const INPATIENT_RATE_SQL = `
  SELECT u.id AS doctor_id,
         CAST(json_extract(j.value, '$.service_id') AS INTEGER) AS service_id,
         MAX(CASE WHEN json_type(j.value, '$.pct') IN ('integer', 'real')
                  THEN CAST(json_extract(j.value, '$.pct') AS REAL) END) AS inpatient_pct,
         MAX(CASE WHEN json_type(j.value, '$.fix') IN ('integer', 'real')
                  THEN CAST(json_extract(j.value, '$.fix') AS REAL) END) AS inpatient_fix
    FROM users u, json_each(CASE WHEN json_valid(u.inpatient_rates) THEN u.inpatient_rates ELSE '[]' END) j
   WHERE u.inpatient_rates IS NOT NULL AND u.inpatient_rates != ''
     AND json_valid(u.inpatient_rates)
     AND (json_type(j.value, '$.pct') IN ('integer', 'real') OR json_type(j.value, '$.fix') IN ('integer', 'real'))
   GROUP BY u.id, CAST(json_extract(j.value, '$.service_id') AS INTEGER)`;
// Фикс, если он есть, иначе процент — ставка у записи одна (routes/users.js).
const INPATIENT_FIX_SQL = `idr.inpatient_fix`;
const INPATIENT_PCT_SQL = `CASE WHEN idr.inpatient_fix IS NOT NULL THEN 0 ELSE COALESCE(idr.inpatient_pct, 0) END`;

// Лучшая активная ставка на (врач, услугу): таблица doctor_rates и JSON
// карточки. PAY_BASIS_PERFORMED_V1 — вынесена именем: её читают и строки
// счёта (ITEM_DOCTOR_JOIN), и строки выполненной работы (performedPayLines).
const DOCTOR_RATE_SQL = `SELECT doctor_id, service_id, MAX(percent) AS percent, MAX(fix) AS fix FROM (
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
             ) GROUP BY doctor_id, service_id`;

// One de-duplicated doctor/rate per invoice item: a single visit_service per
// item, and the best active rate per (doctor, service) — plain LEFT JOINs on
// doctor_rates could multiply rows when duplicates exist.
const ITEM_DOCTOR_JOIN = `
  LEFT JOIN (SELECT invoice_item_id, MIN(doctor_id) AS doctor_id, MIN(id) AS visit_service_id
               FROM visit_services
              WHERE invoice_item_id IS NOT NULL AND doctor_id IS NOT NULL
              GROUP BY invoice_item_id) vs ON vs.invoice_item_id = ii.id
  LEFT JOIN users doc ON doc.id = vs.doctor_id
  LEFT JOIN (${DOCTOR_RATE_SQL}) dr
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
  -- PAY_BASIS_PERFORMED_V1 — выполнена ли работа за этой строкой счёта:
  -- строка визита (pvs) и её визит, госпитализация строки стационара.
  LEFT JOIN visit_services pvs ON pvs.id = vs.visit_service_id
  LEFT JOIN visits pv ON pv.id = pvs.visit_id
  LEFT JOIN admissions ia ON ia.id = ias.admission_id
`;

// DOC_RATE_JSON_V1 — процент строки: персональная ставка за услугу (таблица или
// JSON карточки), иначе ставка по умолчанию из карточки (service_rate_default).
const ITEM_PCT_SQL = `COALESCE(dr.percent, doc.service_rate_default, 0)`;

// DOCTOR_FIX_RATE_V1 — фиксированная ставка врача за единицу услуги (NULL, если
// врач получает процент). Только из карточки: в таблице doctor_rates фикса нет.
const ITEM_FIX_SQL = `dr.fix`;

// DOCTOR_TIER_V1 — кусочки строки. Единицы строки — не меньше 1, чтобы деление
// ниже никогда не было на ноль. PAY_BASIS_PERFORMED_V1 — смесь собирается от
// выражения КОЛИЧЕСТВА: у строки счёта это ii.quantity, у выполненной строки
// без счёта — количество строки визита (performedPayLines). Формула одна.
function tierMixSql(qtyExpr) {
  const qty = `MAX(COALESCE(${qtyExpr}, 1), 1)`;
  // Единицы, ушедшие за порог: 0..qty. Без ступени (tr пуст) MIN даёт NULL → 0.
  const above = `COALESCE(MAX(0, MIN(${qty}, tr.running - tr.tier_from)), 0)`;
  // DOCTOR_TIER_V2 — единицы за порогами 2 и 3; ступени нет (порог 0) — 0.
  // Пороги строго растут (TIER_RANK_SQL), поэтому above ≥ above_2 ≥ above_3.
  const aboveK = (k) => `CASE WHEN COALESCE(tr.tier_from_${k}, 0) > 0
  THEN MAX(0, MIN(${qty}, tr.running - tr.tier_from_${k})) ELSE 0 END`;
  const above2 = aboveK(2);
  const above3 = aboveK(3);
  // Процент ступени — не ниже личного: ступень никого не понижает.
  const tierPct = `MAX(${ITEM_PCT_SQL}, COALESCE(tr.tier_percent, 0))`;
  const tierPct2 = `MAX(${ITEM_PCT_SQL}, COALESCE(tr.tier_percent_2, 0))`;
  const tierPct3 = `MAX(${ITEM_PCT_SQL}, COALESCE(tr.tier_percent_3, 0))`;
  // Действующий процент строки — смесь по единицам: до первого порога личный,
  // дальше каждая единица — по ступени САМОГО ВЫСОКОГО порога, который она
  // перешагнула (полосы: above−above_2, above_2−above_3, above_3).
  // Ветка без ступени выписана явно: строка без tr идёт по ITEM_PCT_SQL бит в бит,
  // а не через арифметику со смесью, где всё держалось бы на MIN(x, NULL).
  const effPct = `CASE WHEN tr.visit_service_id IS NULL THEN ${ITEM_PCT_SQL}
  ELSE ((${ITEM_PCT_SQL} * (${qty} - ${above})
       + ${tierPct} * (${above} - ${above2})
       + ${tierPct2} * (${above2} - ${above3})
       + ${tierPct3} * ${above3}) / (${qty} * 1.0)) END`;
  return { qty, above, effPct };
}
const ITEM_TIER = tierMixSql('ii.quantity');
const ITEM_EFF_PCT_SQL = ITEM_TIER.effPct;

// Invoice-level discount prorated onto this item.
//
// PACKAGES_V1 (мигр. 154) — у строки может быть СВОЯ скидка (скидка пакета,
// invoice_items.discount_amount > 0): тогда она и есть скидка строки. Скидка
// счёта включает её, поэтому по остальным строкам разносится только ОСТАТОК —
// скидка счёта минус свои скидки — пропорционально их доле в сумме строк без
// своей скидки. Без этого скидка пакета на УЗИ урезала бы долю врача за
// анализ в том же счёте. Счёт без своих скидок считается бит в бит как прежде:
// подзапросы дают 0, а x − 0 в плавающей точке — тот же x.
const OWN_DISCOUNT_SUM_SQL = `COALESCE((SELECT SUM(xo.discount_amount) FROM invoice_items xo
  WHERE xo.invoice_id = i.id AND xo.discount_amount > 0), 0)`;
const OWN_DISCOUNT_BASE_SQL = `COALESCE((SELECT SUM(xo.total) FROM invoice_items xo
  WHERE xo.invoice_id = i.id AND xo.discount_amount > 0), 0)`;
const ITEM_DISCOUNT_SQL = `CASE
  WHEN COALESCE(ii.discount_amount, 0) > 0 THEN ii.discount_amount
  WHEN i.subtotal - ${OWN_DISCOUNT_BASE_SQL} > 0
  THEN MAX(i.discount_amount - ${OWN_DISCOUNT_SUM_SQL}, 0) * ii.total / (i.subtotal - ${OWN_DISCOUNT_BASE_SQL})
  ELSE 0 END`;

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
// INPATIENT_BONUS_V1 — фикс стационарной ставки: сумма × количество строки.
const INPATIENT_FEE_SQL = `CASE
  WHEN ${INPATIENT_FIX_SQL} IS NOT NULL THEN ${INPATIENT_FIX_SQL} * COALESCE(ii.quantity, 1)
  ELSE (${ITEM_NET_SQL} * ${INPATIENT_PCT_SQL} / 100.0) END`;
const LINE_FEE_SQL = `CASE WHEN ias.id IS NOT NULL THEN ${INPATIENT_FEE_SQL} ELSE ${ITEM_FEE_SQL} END`;
const LINE_PCT_SQL = `CASE WHEN ias.id IS NOT NULL THEN ${INPATIENT_PCT_SQL} ELSE ${ITEM_EFF_PCT_SQL} END`;
const LINE_FIX_SQL = `CASE WHEN ias.id IS NOT NULL THEN ${INPATIENT_FIX_SQL} ELSE ${ITEM_FIX_SQL} END`;
const LINE_DOCTOR_ID_SQL = `COALESCE(vs.doctor_id, ${INPATIENT_DOCTOR_SQL})`;
// PAY_BASIS_PERFORMED_V1 — строка счёта в отчётах ПО ВЫРУЧКЕ («Общая выручка»,
// «Рентабельность операций», «По услугам») показывает долю врача, только если
// работа за ней выполнена — тем же определением, что выплата
// (performedPayLines). Оплачен ли счёт — не важно. Строка, у которой врача нет
// вовсе, и так даёт 0.
const LINE_PERFORMED_SQL = `CASE
  WHEN i.status IN ('void', 'refunded') THEN 0
  WHEN ias.id IS NOT NULL THEN ${IN_DONE_SQL('ias', 'ia')}
  WHEN pvs.id IS NOT NULL THEN (${VS_PERFORMED_SQL('pvs')} AND ${LIVE_VISIT_SQL('pv')})
  ELSE 0 END`;

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
           ${LINE_FIX_SQL}                    AS doctor_fix,
           -- PAY_BASIS_PERFORMED_V1 — доля только у выполненной работы.
           CASE WHEN ${LINE_PERFORMED_SQL} THEN ${LINE_FEE_SQL} ELSE 0 END AS doctor_fee,
           (${LINE_PERFORMED_SQL})           AS performed,
           ias.id                             AS inpatient_line_id,
           b.name                             AS branch,
           reg.full_name                      AS registrar,
           rs.name                            AS referral,
           -- REFERRAL_CATEGORY_RATES_V1 — id источника и ГРУППА услуги: ставка
           -- теперь своя у каждой группы, поэтому отчёт обязан различать
           -- позиции внутри одной корзины. Название категории приходит из
           -- справочника, а не из бывшей текстовой колонки rs.category.
           -- GROUPS_FIVE_REFERRAL_V1 (мигр. 153): ставку выбирает service_group
           -- (s.type, одна из пяти) ниже; service_type_id осталась только
           -- подписью «Вида услуги» в кабинете врача.
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
           idr.inpatient_pct                  AS inpatient_pct,
           idr.inpatient_fix                  AS inpatient_fix,   -- INPATIENT_BONUS_V1
           -- REPORTS_V2, ревью M7 — оплата счёта, разносимая на строки.
           i.paid_amount                      AS inv_paid,
           i.total_amount                     AS inv_total
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
// PAY_BASIS_PERFORMED_V1 — ОДНА ВЫБОРКА ВЫПЛАТЫ ВРАЧУ: строки выполненной
// работы (определение «выполнена» — у VS_PERFORMED_SQL выше), по ним
// считаются «Зарплаты врачей», «Стационар: доля врачей», «По врачам»,
// «Врач × услуга» и кабинет врача (doctor_pay_summary). Прежде это были
// строки ОПЛАЧЕННЫХ счетов по дате счёта, а кабинет считал в браузере по
// строкам визита — суммы расходились.
//
//   ДАТА строки — местный день: у амбулаторной — день ВИЗИТА (visits.visit_date;
//     отметки «когда завершена» у visit_services нет, и ступень считает месяц
//     по ней же), у стационарной — день отметки «Выполнено» (performed_at).
//   ДЕНЬГИ строки со счётом — ровно как прежде: строка счёта − её доля скидки
//     счёта − налог (ITEM_DISCOUNT_SQL / ITEM_TAX_SQL / ITEM_NET_SQL).
//   ДЕНЬГИ строки без счёта — то, что выставит счёт (payLineMoney ниже): цена
//     lineUnitPrice (своя цена врача, иначе каталог; у визита — ступень цены
//     визита) × количество, минус скидка категории пациента
//     (patientCategoryDiscount — у амбулаторной строки; счёт стационара скидки
//     не даёт), минус налог услуги. Ручную скидку кассира заранее знать
//     нельзя — появится счёт, и строка пойдёт по нему.
//   ДОЛЯ — фикс за единицу, иначе (после налога) × действующий процент:
//     COALESCE(личная ставка, service_rate_default, 0) со ступенью по объёму;
//     у стационара — «Стационар, %» исполнителя (иначе назначившего).
//
// Строки соседнего здания (приехавшие счета без врача, BUILDING_REPORTS_V1)
// идут в отчётах отдельной строкой «<здание>, врач не указан» — по дате счёта,
// без доли: выполнена ли там работа, отсюда не видно.
// ---------------------------------------------------------------------------
const PERF_TIER = tierMixSql('CASE WHEN ii.id IS NOT NULL THEN ii.quantity ELSE vs.quantity END');

// Общий хвост денег строки со счётом (NULL, когда счёта нет).
const BILLED_COLUMNS_SQL = `
           ii.id                              AS invoice_item_id,
           i.invoice_number                   AS invoice,
           i.status                           AS status,
           i.paid_amount                      AS inv_paid,
           i.total_amount                     AS inv_total,
           ii.total                           AS billed_amount,
           CASE WHEN ii.id IS NOT NULL THEN ${ITEM_DISCOUNT_SQL} END AS billed_discount,
           CASE WHEN ii.id IS NOT NULL THEN ${ITEM_TAX_SQL} END      AS billed_tax,
           CASE WHEN ii.id IS NOT NULL THEN ${ITEM_NET_SQL} END      AS billed_net`;

function outpatientPayRows(db, { from, to, doctorId, bf, gf, withoutDoctor = false }) {
  const docClause = doctorId != null ? ' AND vs.doctor_id = ?' : '';
  // DOCTOR_LINES_SPECIALTY_V1 — «По специальностям» показывает и выполненные
  // строки без врача (лаборатория и т. п.): доли у них нет (ставку брать не у
  // кого), но работа и деньги — есть. Выплате они не нужны.
  const docRequired = withoutDoctor ? '1 = 1' : 'vs.doctor_id IS NOT NULL';
  // Строка без врача, связанная со строкой счёта, входит, только если с этой
  // строкой счёта не связана строка С врачом (та и считается), и только
  // первая такая — деньги строки счёта не удваиваются.
  const noDocJoin = withoutDoctor
    ? `LEFT JOIN (SELECT invoice_item_id, MIN(id) AS first_id FROM visit_services
                   WHERE invoice_item_id IS NOT NULL AND doctor_id IS NULL GROUP BY invoice_item_id) fn
             ON fn.invoice_item_id = vs.invoice_item_id`
    : '';
  const noDocPick = withoutDoctor
    ? ' OR (vs.doctor_id IS NULL AND fv.invoice_item_id IS NULL AND fn.first_id = vs.id)'
    : '';
  return db.prepare(`
    SELECT ${originExpr(db, 'visit_services', 'vs')} AS origin,
           'out'                              AS kind,
           vs.id                              AS line_id,
           ${localDate('v.visit_date')}       AS date,
           vs.status                          AS line_status,
           v.id                               AS visit_id,
           NULL                               AS admission_id,
           NULL                               AS admission_no,
           v.patient_id                       AS patient_id,
           pt.full_name                       AS patient,
           pt.mrn                             AS mrn,
           vs.doctor_id                       AS doctor_id,
           doc.full_name                      AS doctor,
           NULL                               AS doctor_role,
           COALESCE(ii.service_id, vs.service_id) AS service_id,
           COALESCE(s.name, ii.description, pr.name) AS service,
           s.type                             AS service_group,
           s.is_lab                           AS service_is_lab,
           CASE WHEN ii.id IS NOT NULL THEN ii.quantity ELSE vs.quantity END AS qty,
           COALESCE(s.tax_rate, 0)            AS tax_rate,
           ${BILLED_COLUMNS_SQL},
           vs.clinic_item_id                  AS clinic_item_id,
           vs.unit_price                      AS line_unit_price,
           vs.price_tier                      AS price_tier,
           -- PACKAGES_V1 — скидка пакета строки (для строки без счёта).
           (SELECT pk.discount_percent FROM service_templates pk WHERE pk.id = vs.package_id) AS package_pct,
           vs.doctor_id                       AS price_doctor_id,
           ${PERF_TIER.effPct}                AS pct,
           NULL                               AS inpatient_pct,
           ${ITEM_FIX_SQL}                    AS fix,
           CASE WHEN tr.visit_service_id IS NULL THEN 0 ELSE ${PERF_TIER.above} END AS tier_units_above
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
      LEFT JOIN patients pt      ON pt.id = v.patient_id
      LEFT JOIN invoice_items ii ON ii.id = vs.invoice_item_id
      LEFT JOIN invoices i       ON i.id = ii.invoice_id
      LEFT JOIN services s       ON s.id = COALESCE(ii.service_id, vs.service_id)
      LEFT JOIN products pr      ON pr.id = vs.clinic_item_id
      LEFT JOIN users doc        ON doc.id = vs.doctor_id
      LEFT JOIN (${DOCTOR_RATE_SQL}) dr
             ON dr.doctor_id = vs.doctor_id AND dr.service_id = COALESCE(ii.service_id, vs.service_id)
      LEFT JOIN (${TIER_RANK_SQL}) tr ON tr.visit_service_id = vs.id AND tr.doctor_id = vs.doctor_id
      -- Одна строка визита на строку счёта (как ITEM_DOCTOR_JOIN): вторая
      -- строка, ошибочно связанная с тем же счётом, не получила бы деньги дважды.
      LEFT JOIN (${VS_BY_ITEM_SQL}) fv ON fv.invoice_item_id = vs.invoice_item_id
      ${noDocJoin}
     WHERE ${docRequired}
       AND ${OUT_PERFORMED_SQL('vs', 'v', 'i')}
       AND (vs.invoice_item_id IS NULL OR fv.first_id = vs.id${noDocPick})
       AND ${inLocalRange('v.visit_date')}${docClause}${bf.out.clause}${gf.out.clause}
     ORDER BY v.visit_date, vs.id
  `).all(from, to, ...(doctorId != null ? [doctorId] : []), ...bf.out.params, ...gf.out.params);
}

function inpatientPayRows(db, { from, to, doctorId, bf, gf }) {
  const docClause = doctorId != null ? ` AND ${INPATIENT_DOCTOR_SQL} = ?` : '';
  return db.prepare(`
    SELECT ''                                 AS origin,
           'in'                               AS kind,
           ias.id                             AS line_id,
           ${localDate('ias.performed_at')}   AS date,
           'completed'                        AS line_status,
           NULL                               AS visit_id,
           ias.admission_id                   AS admission_id,
           COALESCE(NULLIF(a.admission_no, ''), CAST(ias.admission_id AS TEXT)) AS admission_no,
           a.patient_id                       AS patient_id,
           pt.full_name                       AS patient,
           pt.mrn                             AS mrn,
           ${INPATIENT_DOCTOR_SQL}            AS doctor_id,
           idoc.full_name                     AS doctor,
           CASE WHEN ias.performer_id IS NOT NULL THEN 'performer' ELSE 'ordering' END AS doctor_role,
           ias.service_id                     AS service_id,
           COALESCE(s.name, ii.description)   AS service,
           s.type                             AS service_group,
           s.is_lab                           AS service_is_lab,
           CASE WHEN ii.id IS NOT NULL THEN ii.quantity ELSE ias.quantity END AS qty,
           COALESCE(s.tax_rate, 0)            AS tax_rate,
           ${BILLED_COLUMNS_SQL},
           NULL                               AS clinic_item_id,
           ias.unit_price                     AS line_unit_price,
           NULL                               AS price_tier,
           NULL                               AS package_pct,
           -- Счёт стационара берёт свою цену НАЗНАЧИВШЕГО (buildAdmissionInvoice).
           ias.doctor_id                      AS price_doctor_id,
           ${INPATIENT_PCT_SQL}               AS pct,
           idr.inpatient_pct                  AS inpatient_pct,
           -- INPATIENT_BONUS_V1 — фикс стационарной ставки за единицу (payLineMoney).
           ${INPATIENT_FIX_SQL}               AS fix,
           0                                  AS tier_units_above
      FROM admission_services ias
      JOIN admissions a          ON a.id = ias.admission_id
      LEFT JOIN patients pt      ON pt.id = a.patient_id
      LEFT JOIN invoice_items ii ON ii.id = ias.invoice_item_id
      LEFT JOIN invoices i       ON i.id = ii.invoice_id
      LEFT JOIN services s       ON s.id = ias.service_id
      LEFT JOIN users idoc       ON idoc.id = ${INPATIENT_DOCTOR_SQL}
      LEFT JOIN (${INPATIENT_RATE_SQL}) idr ON idr.doctor_id = ${INPATIENT_DOCTOR_SQL}
                                           AND idr.service_id = ias.service_id
      -- Строка счёта, у которой есть амбулаторный врач, — амбулаторная (та же
      -- развилка, что в ITEM_DOCTOR_JOIN); сгруппированный LEFT JOIN, а не
      -- коррелированный NOT EXISTS (ревью C1, reports.scale.test.js).
      LEFT JOIN (${VS_BY_ITEM_SQL}) ovs ON ovs.invoice_item_id = ias.invoice_item_id
      -- Одна строка стационара на строку счёта (MIN(id), как INPATIENT_LINE_PICK_SQL).
      LEFT JOIN (SELECT x.invoice_item_id, MIN(x.id) AS first_id FROM admission_services x
                  WHERE x.invoice_item_id IS NOT NULL AND ${IN_MEDICAL_SQL('x')}
                  GROUP BY x.invoice_item_id) fa ON fa.invoice_item_id = ias.invoice_item_id
     WHERE ${IN_MEDICAL_SQL('ias')}
       AND ${IN_DONE_SQL('ias', 'a')}
       AND ${LIVE_INVOICE_SQL('i')}
       -- Ревью M5: строка стационара, связанная со строкой счёта ДРУГОЙ
       -- услуги, доли не даёт.
       AND (ias.invoice_item_id IS NULL
            OR (ii.service_id = ias.service_id AND fa.first_id = ias.id AND ovs.invoice_item_id IS NULL))
       AND ${inLocalRange('ias.performed_at')}${docClause}${bf.in.clause}${gf.in.clause}
     ORDER BY ias.performed_at, ias.id
  `).all(from, to, ...(doctorId != null ? [doctorId] : []), ...bf.in.params, ...gf.in.params);
}

// Строки соседнего здания: приехавший счёт, врача у него нет (id сотрудников
// между зданиями не путешествуют), выполнение отсюда не видно — поэтому только
// в отчётах, по дате счёта и без доли, как и прежде.
function foreignPayRows(db, { from, to, bf, gf }) {
  if (!hasColumn(db, 'invoices', 'sync_origin')) return [];
  return db.prepare(`
    SELECT ${originExpr(db, 'invoices', 'i')}  AS origin,
           'out'                              AS kind,
           ii.id                              AS line_id,
           ${localDate('i.created_at')}       AS date,
           NULL                               AS line_status,
           i.visit_id                         AS visit_id,
           i.admission_id                     AS admission_id,
           NULL                               AS admission_no,
           i.patient_id                       AS patient_id,
           pt.full_name                       AS patient,
           pt.mrn                             AS mrn,
           NULL                               AS doctor_id,
           NULL                               AS doctor,
           NULL                               AS doctor_role,
           ii.service_id                      AS service_id,
           COALESCE(s.name, ii.description)   AS service,
           s.type                             AS service_group,
           s.is_lab                           AS service_is_lab,
           ii.quantity                        AS qty,
           COALESCE(s.tax_rate, 0)            AS tax_rate,
           ${BILLED_COLUMNS_SQL},
           NULL AS clinic_item_id, NULL AS line_unit_price, NULL AS price_tier, NULL AS package_pct, NULL AS price_doctor_id,
           0 AS pct, NULL AS inpatient_pct, NULL AS fix, 0 AS tier_units_above
      FROM invoice_items ii
      JOIN invoices i       ON i.id = ii.invoice_id
      LEFT JOIN patients pt ON pt.id = i.patient_id
      LEFT JOIN services s  ON s.id = ii.service_id
      LEFT JOIN (${VS_BY_ITEM_SQL}) ovs ON ovs.invoice_item_id = ii.id
     WHERE i.sync_origin IS NOT NULL
       AND i.status NOT IN ('void', 'refunded')
       AND ovs.invoice_item_id IS NULL
       AND ${inLocalRange('i.created_at')}${bf.inv.clause}${gf.inv.clause}
     ORDER BY i.created_at, ii.id
  `).all(from, to, ...bf.inv.params, ...gf.inv.params);
}

// Цена строки без счёта и скидка категории — с кэшем на выборку: одна и та же
// услуга у одного врача спрашивается один раз.
function makePayPricer(db) {
  const svcStmt = db.prepare(`SELECT price, name, price_secondary, secondary_days_from, secondary_days_to,
                                     price_repeat, repeat_days_from, repeat_days_to FROM services WHERE id = ?`);
  const prodStmt = db.prepare('SELECT sale_price FROM products WHERE id = ?');
  const units = new Map();
  const cats = new Map();
  return {
    unit(r) {
      const tiered = r.kind === 'out';
      const key = [r.kind, r.service_id, r.clinic_item_id, r.price_doctor_id, r.price_tier,
        r.service_id == null && r.clinic_item_id == null ? r.line_unit_price : ''].join('|');
      if (!units.has(key)) {
        const row = { service_id: r.service_id, clinic_item_id: r.clinic_item_id, doctor_id: r.price_doctor_id,
                      price_tier: r.price_tier, unit_price: r.line_unit_price };
        const service = r.service_id != null ? svcStmt.get(r.service_id) || null : null;
        const product = r.clinic_item_id != null ? prodStmt.get(r.clinic_item_id) || null : null;
        units.set(key, Number(lineUnitPrice(db, row, { service, product, tiered })) || 0);
      }
      return units.get(key);
    },
    categoryPct(patientId) {
      if (!cats.has(patientId)) cats.set(patientId, patientCategoryDiscount(db, patientId));
      return cats.get(patientId);
    },
  };
}

/**
 * Деньги и доля ОДНОЙ строки выплаты — одна функция на все отчёты и кабинет.
 * Строка со счётом: суммы из SQL (как прежде). Без счёта: цена счёта.
 */
function payLineMoney(r, pricer) {
  let amount, discount, tax, net;
  if (r.invoice_item_id != null) {
    amount = r.billed_amount || 0;
    discount = r.billed_discount || 0;
    tax = r.billed_tax || 0;
    net = r.billed_net || 0;
  } else {
    const qty = Number(r.qty) || 0;
    amount = round2(pricer.unit(r) * qty);
    const catPct = r.kind === 'out' ? pricer.categoryPct(r.patient_id) : 0;
    // PACKAGES_V1 — строка пакета со скидкой: бо́льшая из скидки пакета и
    // категории, не обе (ровно как create_invoice_for_visit).
    const pkgPct = r.kind === 'out' && Number(r.package_pct) > 0 ? Math.min(Number(r.package_pct), 100) : 0;
    const pct = Math.max(catPct, pkgPct);
    discount = pct > 0 ? round2(amount * pct / 100) : 0;
    const after = amount - discount;
    tax = after * (Number(r.tax_rate) || 0) / 100;
    net = after - tax;
  }
  // DOCTOR_FIX_RATE_V1 — фикс за единицу и налогом не режется; иначе процент
  // от суммы после налога (DOCTOR_SHARE_AFTER_TAX_V1) — тот же порядок
  // действий, что у ITEM_FEE_SQL, поэтому у строки со счётом число прежнее.
  const fee = r.fix != null
    ? r.fix * (r.qty == null ? 1 : r.qty)
    : net * (r.pct || 0) / 100;
  return { amount, discount, tax, net, fee };
}

const EMPTY_FILTER = { clause: '', params: [] };
/**
 * Строки выплаты за период [from, to] (местные дни).
 * @param opts.doctorId  — только этот врач (кабинет); строк соседнего здания нет.
 * @param opts.kinds     — ['out','in'] по умолчанию; кабинет стационара — ['in'].
 * @param opts.args/ctx  — фильтры отчёта: branch_ids, здания; foreign — строки
 *                         соседнего здания (только отчётам).
 * @param opts.withoutDoctor — и амбулаторные строки без врача (доля 0);
 *                         только «По специальностям», выплате не нужны.
 */
export function performedPayLines(db, { from, to, doctorId = null, kinds = ['out', 'in'], args = null, ctx = null, foreign = false, withoutDoctor = false } = {}) {
  const bf = {
    out: branchFilter(args, 'v.branch_id'),
    // У строки стационара филиал — у её счёта (у госпитализации его нет), как
    // прежде: фильтр по филиалу строку без счёта не пропускает.
    in: branchFilter(args, 'i.branch_id'),
    inv: branchFilter(args, 'i.branch_id'),
  };
  const gf = ctx ? {
    out: buildingWhere(db, ctx, args, 'visit_services', 'vs'),
    in: buildingWhere(db, ctx, args, 'admission_services', 'ias'),
    inv: buildingWhere(db, ctx, args, 'invoices', 'i'),
  } : { out: EMPTY_FILTER, in: EMPTY_FILTER, inv: EMPTY_FILTER };
  const q = { from, to, doctorId: doctorId != null ? Number(doctorId) : null, bf, gf, withoutDoctor: withoutDoctor && doctorId == null };
  const raw = [
    ...(kinds.includes('out') ? outpatientPayRows(db, q) : []),
    ...(kinds.includes('in') ? inpatientPayRows(db, q) : []),
    ...(foreign && doctorId == null && kinds.includes('out') ? foreignPayRows(db, q) : []),
  ];
  const pricer = makePayPricer(db);
  return raw.map((r) => {
    const m = payLineMoney(r, pricer);
    return {
      ...r,
      invoiced: r.invoice_item_id != null,
      inpatient_line_id: r.kind === 'in' ? r.line_id : null,
      amount: m.amount, discount: m.discount, tax: m.tax, net: m.net,
      doctor_fee: m.fee,
    };
  });
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
               - (CASE WHEN EXISTS (SELECT 1 FROM invoice_items xo WHERE xo.invoice_id = i.id AND xo.discount_amount > 0)
                  -- PACKAGES_V1 — у счёта есть строки со своей скидкой: строки
                  -- после скидки считаются тем же ITEM_DISCOUNT_SQL, что и
                  -- отчёт, а не общей долей скидки счёта.
                  THEN COALESCE((SELECT SUM(ii.total - (${ITEM_DISCOUNT_SQL})) FROM invoice_items ii WHERE ii.invoice_id = i.id), 0)
                  ELSE COALESCE((SELECT SUM(ii.total) FROM invoice_items ii WHERE ii.invoice_id = i.id), 0)
                 -- * 1.0 обязательно: subtotal и discount_amount целые, и без
                 -- него SQLite поделил бы нацело — доля скидки стала бы 0 или 1.
                 * (CASE WHEN COALESCE(i.subtotal, 0) > 0
                         THEN (i.subtotal - COALESCE(i.discount_amount, 0)) * 1.0 / i.subtotal
                         ELSE 1.0 END) END) AS gap
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
    notes: [PERFORMED_NOTE, REVENUE_SHARE_NOTE, ...(hasUnattributed(ctx, src) ? [UNATTRIBUTED_NOTE] : [])],
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
    // INPATIENT_BONUS_V1 — строка счёта ГОСПИТАЛИЗАЦИИ по обычным ставкам групп
    // больше не платится никому: у стационара своё вознаграждение
    // (inpatientReferralLines ниже) — только у партнёра с переключателем.
    if (r.admission_id != null) continue;
    const internal = isInternalReferral(r);
    if (scope === 'internal' && !internal) continue;
    if (scope === 'external' && internal) continue;
    if (doctorId != null && Number(r.referral_doctor_id) !== Number(doctorId)) continue;
    const src = r.referral_source_id != null ? sources.get(r.referral_source_id) : null;
    const cat = src && src.category_id != null ? categories.get(src.category_id) : null;
    // GROUPS_FIVE_REFERRAL_V1 — ставка по ГРУППЕ услуги (services.type, одна
    // из пяти), а не по строке справочника типов. Строка без услуги — без группы.
    const serviceGroup = r.service_id != null ? referralGroupOf(r.service_group) : null;
    const rate = resolveReferralRate({ source: src, category: cat, serviceGroup });
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
      where: 'out',
      beneficiary_doctor_id: r.referral_doctor_id ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// INPATIENT_BONUS_V1 (владелец, 26.09) — ВОЗНАГРАЖДЕНИЕ ЗА НАПРАВЛЕНИЕ В СТАЦИОНАР.
//
// КТО НАПРАВИЛ. У строки счёта госпитализации визита нет (visit_id NULL,
// billing.js buildAdmissionInvoice), поэтому направивший берётся у самой
// госпитализации — admissions.referral_source_id (мигр. 155, выбирается в
// заявке), а у госпитализаций, где его нет, — из карточки пациента, как
// прежде. Получателей два, и они независимы:
//
//   ПАРТНЁР (источник направления) — только если у его карточки включено
//     «Вознаграждение за стационар» (inpatient_bonus_enabled). Выключено —
//     ноль, какие бы ставки групп у него ни стояли: обычные ставки групп к
//     строкам госпитализации не применяются НИКОГДА (referralLines их
//     пропускает). Источник, связанный с сотрудником (внутренний источник
//     врача, мигр. 122), по карточке источника за стационар не платит:
//     сотрудник получает своё по вкладке «Стационар» как направивший врач
//     госпитализации — иначе один человек получал бы за одну госпитализацию
//     дважды.
//   НАПРАВИВШИЙ ВРАЧ (admissions.doctor_id — «Направивший врач» заявки;
//     размещение без него ставит туда лечащего, inpatient.js admitPatient) —
//     по своей вкладке «Стационар» (users.inpatient_referral_pct / _fixed).
//     Это та же колонка, которую заявка и кабинет врача уже называют
//     «направивший», и единственное место, где в госпитализации записано,
//     какой сотрудник отправил пациента в стационар.
//
// ФОРМУЛА (одна на обоих, различаются только числа):
//   % × база: база — строки ОПЛАЧЕННЫХ (status 'paid') счетов госпитализации,
//     сумма строки после её доли скидки счёта (ITEM_DISCOUNT_SQL; налог не
//     вычитается — так же, как у обычного вознаграждения за направления).
//     В базу входят УСЛУГИ (строка с услугой каталога) и КОЙКО-ДНИ (строка
//     проживания, shared/accommodation-line.js); ТОВАРЫ — медикаменты и
//     расходники (строка стационара с clinic_item_id) — не входят; строка
//     счёта без строки стационара и без услуги — тоже.
//   фикс — ОДИН раз на госпитализацию, со ПЕРВОГО оплаченного счёта этой
//     госпитализации (меньший id среди её счетов в статусе 'paid'), в период
//     по дате этого счёта. Второй и следующие счета фикса не дают; счёт
//     вернули — фикс переходит к следующему оплаченному, если он есть.
//   Неоплаченный счёт не приносит ничего. База ВЫПЛАТЫ — оплаченные счета,
//     как у всех денег, уходящих за направления (у доли врача за работу база
//     другая — выполненные услуги, PAY_BASIS_PERFORMED_V1): вознаграждение за
//     направление — это деньги с денег, которые клиника получила.
// ---------------------------------------------------------------------------
const INPATIENT_KIND_RU = { service: 'Услуга', bed: 'Койко-дни', fixed: 'Фикс за госпитализацию' };

function inpatientReferralLines(db, args, ctx) {
  const scope = referrerScope(args);
  const { from, to } = resolveRange(db, args);
  const bf = branchFilter(args, 'i.branch_id');
  const gf = buildingWhere(db, ctx, args, 'invoices', 'i');
  const rows = db.prepare(`
    SELECT ${originExpr(db, 'invoices', 'i')}  AS origin,
           ${localDate('i.created_at')}       AS date,
           i.id                               AS invoice_id,
           i.invoice_number                   AS invoice,
           i.status                           AS status,
           i.admission_id                     AS admission_id,
           COALESCE(NULLIF(a.admission_no, ''), CAST(a.id AS TEXT)) AS admission_no,
           i.patient_id                       AS patient_id,
           pt.full_name                       AS patient,
           pt.mrn                             AS mrn,
           ii.id                              AS item_id,
           COALESCE(s.name, NULLIF(ii.description, '')) AS service,
           ii.quantity                        AS qty,
           ii.total                           AS amount,
           ${ITEM_DISCOUNT_SQL}               AS discount,
           CASE WHEN ak.goods = 1 THEN 'goods'
                WHEN ii.service_id IS NOT NULL THEN 'service'
                WHEN ak.bed = 1 THEN 'bed'
                ELSE 'other' END              AS line_kind,
           COALESCE(a.referral_source_id, pt.referral_source_id) AS source_id,
           a.doctor_id                        AS admission_doctor_id
      FROM invoice_items ii
      JOIN invoices i   ON i.id = ii.invoice_id
      JOIN admissions a ON a.id = i.admission_id
      JOIN patients pt  ON pt.id = i.patient_id
      LEFT JOIN services s ON s.id = ii.service_id
      LEFT JOIN (SELECT x.invoice_item_id,
                        MAX(CASE WHEN x.clinic_item_id IS NOT NULL THEN 1 ELSE 0 END) AS goods,
                        MAX(CASE WHEN x.service_id IS NULL AND x.clinic_item_id IS NULL
                                  AND COALESCE(x.notes, '') LIKE 'ACCOMMODATION%' THEN 1 ELSE 0 END) AS bed
                   FROM admission_services x
                  WHERE x.invoice_item_id IS NOT NULL
                  GROUP BY x.invoice_item_id) ak ON ak.invoice_item_id = ii.id
     WHERE i.admission_id IS NOT NULL
       AND ${inLocalRange('i.created_at')}
       AND i.status <> 'void'${bf.clause}${gf.clause}
     ORDER BY origin, i.created_at, i.id, ii.id
  `).all(from, to, ...bf.params, ...gf.params);
  if (!rows.length) return [];

  const sources = new Map(db.prepare(`SELECT rs.id, rs.name, rs.code, rs.doctor_id, rs.inpatient_bonus_enabled,
                                              rs.inpatient_pct, rs.inpatient_fixed, rc.name AS category_name, rc.is_internal
                                         FROM referral_sources rs
                                         LEFT JOIN referral_source_categories rc ON rc.id = rs.category_id`).all()
    .map((r) => [r.id, r]));
  const doctors = new Map(db.prepare(`SELECT id, COALESCE(NULLIF(full_name, ''), username) AS name,
                                             inpatient_referral_pct, inpatient_referral_fixed
                                        FROM users WHERE inpatient_referral_pct > 0 OR inpatient_referral_fixed > 0`).all()
    .map((u) => [u.id, u]));
  // Первый оплаченный счёт каждой госпитализации — за ВСЁ время, а не за
  // период: фикс принадлежит ему, в какой бы период ни попал отчёт.
  const firstPaid = new Map(db.prepare(`SELECT admission_id, MIN(id) AS id FROM invoices
                                          WHERE admission_id IS NOT NULL AND status = 'paid'
                                          GROUP BY admission_id`).all().map((r) => [r.admission_id, r.id]));

  // Получатели строки: партнёр (источник без связи с сотрудником) и
  // направивший врач (если у него задано вознаграждение).
  const beneficiaries = (r) => {
    const out = [];
    const src = r.source_id != null ? sources.get(r.source_id) : null;
    if (src && src.doctor_id == null) {
      const on = Number(src.inpatient_bonus_enabled) === 1;
      out.push({
        key: 'src:' + src.id, referral_source_id: src.id, referral: src.name, referral_code: src.code || '',
        internal: Number(src.is_internal) === 1, category_name: src.category_name || '',
        mode: on ? 'Стационар — карточка источника' : 'Стационар выключен',
        pct: on ? Number(src.inpatient_pct) || 0 : 0,
        fixed: on ? Number(src.inpatient_fixed) || 0 : 0,
        beneficiary_doctor_id: null,
      });
    }
    const doc = r.admission_doctor_id != null ? doctors.get(r.admission_doctor_id) : null;
    if (doc) {
      out.push({
        key: 'doc:' + doc.id, referral_source_id: null, referral: doc.name, referral_code: '',
        internal: true, category_name: '',
        mode: 'Стационар — карточка сотрудника',
        pct: Number(doc.inpatient_referral_pct) || 0,
        fixed: Number(doc.inpatient_referral_fixed) || 0,
        beneficiary_doctor_id: doc.id,
      });
    }
    return out.filter((b) => (scope === 'all' || (scope === 'internal') === b.internal));
  };

  const out = [];
  const fixedDone = new Set();   // admission|получатель — фикс уже выдан
  // Строка фикса встаёт ПОСЛЕ строк своего счёта (детализация читается
  // «строки счёта, затем фикс за госпитализацию»).
  let pendingFixed = [];
  for (let k = 0; k < rows.length; k += 1) {
    const r = rows[k];
    const flush = () => {
      const next = rows[k + 1];
      if (!next || next.invoice_id !== r.invoice_id) { out.push(...pendingFixed); pendingFixed = []; }
    };
    const bs = beneficiaries(r);
    if (!bs.length) { flush(); continue; }
    const paid = r.status === 'paid';
    const base = {
      origin: r.origin, date: r.date, invoice: r.invoice, status: r.status, paid,
      patient_id: r.patient_id, patient: r.patient, mrn: r.mrn,
      admission_id: r.admission_id, admission_no: r.admission_no, where: 'in',
    };
    const isFirstPaid = paid && firstPaid.get(r.admission_id) === r.invoice_id;
    for (const b of bs) {
      const who = { referral_source_id: b.referral_source_id, referral: b.referral, referral_code: b.referral_code,
                    internal: b.internal, category_name: b.category_name, mode: b.mode,
                    beneficiary_key: b.key, beneficiary_doctor_id: b.beneficiary_doctor_id };
      if (r.line_kind === 'service' || r.line_kind === 'bed') {
        const after = (Number(r.amount) || 0) - (Number(r.discount) || 0);
        out.push({
          ...base, ...who,
          line_kind: r.line_kind,
          service: r.service || (r.line_kind === 'bed' ? 'Проживание в палате' : ''),
          qty: r.qty, amount: r.amount, discount: r.discount, after_discount: after,
          rate: { unit: 'pct', value: b.pct },
          reward: paid && b.pct > 0 ? after * b.pct / 100 : 0,
        });
      }
      const fk = r.admission_id + '|' + b.key;
      if (isFirstPaid && b.fixed > 0 && !fixedDone.has(fk)) {
        fixedDone.add(fk);
        pendingFixed.push({
          ...base, ...who,
          line_kind: 'fixed', service: INPATIENT_KIND_RU.fixed,
          qty: 1, amount: 0, discount: 0, after_discount: 0,
          rate: { unit: 'fix', value: b.fixed },
          reward: b.fixed,
        });
      }
    }
    flush();
  }
  return out;
}

// Кому из сотрудников идёт строка вознаграждения: амбулаторная — сотруднику
// внутреннего источника, стационарная — направившему врачу госпитализации.
const referralDoctorOf = (r) => (r.beneficiary_doctor_id == null ? null : Number(r.beneficiary_doctor_id));

// Все строки вознаграждения за направления: амбулаторные (обычные ставки
// групп) и стационарные (INPATIENT_BONUS_V1).
function allReferralLines(db, args, ctx) {
  return [...referralLines(db, args, ctx), ...inpatientReferralLines(db, args, ctx)];
}

// INPATIENT_BONUS_V1 — правило стационара словами, под обоими отчётами.
const REFERRAL_INPATIENT_NOTE = 'Стационар (строки «Где: Стационар») — отдельное вознаграждение: партнёру — только при включённом «Вознаграждении за стационар» в его карточке, направившему врачу госпитализации — по вкладке «Стационар» его карточки. Процент — от оплаченных строк счёта госпитализации после скидки: услуги и койко-дни, без медикаментов и расходников; фиксированная сумма — один раз за госпитализацию, с первого оплаченного счёта. Обычные ставки групп к строкам стационара не применяются. Кто направил — из заявки на госпитализацию, иначе из карточки пациента.';

function referralNotes(db, lines) {
  const notes = [REFERRAL_BASE_NOTE];
  if (lines.some((r) => r.where !== 'in') && !anyReferralRate(db)) notes.push(REFERRAL_ZERO_NOTE);
  if (lines.some((r) => r.where === 'in')) notes.push(REFERRAL_INPATIENT_NOTE);
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
  //
  // INPATIENT_BONUS_V1 — стационар идёт СВОЕЙ строкой того же направившего
  // («Где»), а направивший врач госпитализации — строкой сотрудника.
  const lines = allReferralLines(db, args, ctx);
  const buckets = new Map();
  for (const r of lines) {
    const who = r.beneficiary_key || (r.referral_source_id != null ? 'id:' + r.referral_source_id : 'nm:' + r.referral);
    const key = ctx.keyOf(r.origin) + '\u0000' + who + '\u0000' + r.where;
    const b = buckets.get(key) || {
      origin: r.origin, source: r.referral, code: r.referral_code || '',
      kind: r.internal ? 'internal' : 'external', where: r.where,
      category: r.category_name, mode: r.mode,
      patients: new Set(), count: 0, amount: 0, paid: 0, reward: 0,
    };
    b.patients.add(r.patient_id);
    // Строка фикса за госпитализацию — не услуга: в «Услуг» не считается.
    if (r.line_kind !== 'fixed') b.count += 1;
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
    return [ctx.label(b.origin), b.code, b.source, REFERRER_KIND_RU[b.kind], WHERE_RU[b.where], b.category, b.mode,
            b.patients.size, b.count, round2(b.amount), round2(b.paid), round2(eff), round2(b.reward)];
  });
  return {
    columns: [BUILDING_COL, 'Номер', 'Источник', 'Вид', 'Где', 'Категория', 'Режим ставок', 'Пациентов', 'Услуг',
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
  const lines = allReferralLines(db, args, ctx);   // INPATIENT_BONUS_V1 — и стационар
  return {
    columns: [BUILDING_COL, 'Дата', '№ счёта', 'Статус', 'Номер', 'Источник', 'Вид', 'Где', 'Пациент', 'МРН',
              '№ госпитализации', 'Услуга', 'Кол-во', 'Сумма после скидки', 'Ставка', 'Вознаграждение'],
    rows: lines.map((r) => [ctx.label(r.origin), r.date, r.invoice || '', INV_STATUS_RU[r.status] || r.status,
      r.referral_code || '', r.referral, REFERRER_KIND_RU[r.internal ? 'internal' : 'external'], WHERE_RU[r.where],
      r.patient, r.mrn || '', r.admission_no || '', r.service || '', r.qty, round2(r.after_discount), rateText(r.rate), round2(r.reward)]),
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
  // ROLE_REPORTS_SETTINGS_V1 — вознаграждение за направления видит и группа
  // «Рефералы»: в её отчёте то же вознаграждение каждого врача по строкам.
  assertCanSeeDoctorPay(db, user, doctorId, ['reports.doctor_pay', 'reports.referrals']);   // ревью I6
  const { from, to } = resolveRange(db, args);
  return doctorReferralRows(db, { from, to, doctorId });
}

// Строки вознаграждения врача-направившего — ОДНИ для doctor_referral_reward и
// doctor_pay_summary (PAY_BASIS_PERFORMED_V1). Правило не меняется: только
// оплаченные счета, по дате счёта (referralLines).
function doctorReferralRows(db, { from, to, doctorId }) {
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

// INPATIENT_BONUS_V1 — «За направление в стационар» врача для кабинета: ТЕ ЖЕ
// строки, что в «Рефералах» (inpatientReferralLines), отобранные по врачу,
// которому они идут (направивший врач госпитализации). База — оплаченные
// счета, по дате счёта, как у всякого вознаграждения за направления, — а не
// выполненные услуги, по которым платится работа врача: это деньги с денег,
// которые клиника уже получила.
function doctorInpatientReferralRows(db, { from, to, doctorId }) {
  const ctx = buildingContext(db);
  const lines = inpatientReferralLines(db, { from, to }, ctx).filter((r) => referralDoctorOf(r) === Number(doctorId));
  const rows = lines.map((r) => ({
    date: r.date, invoice: r.invoice, status: r.status, paid: r.paid,
    patient: r.patient, mrn: r.mrn || '', admission_no: r.admission_no || '',
    service: r.service || '', kind: r.line_kind,
    qty: r.qty, amount: round2(r.after_discount), rate: rateText(r.rate), reward: round2(r.reward),
  }));
  return {
    from, to, rows,
    count: rows.length,
    admissions: new Set(lines.map((r) => r.admission_id)).size,
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
// Ревью M8 — единица товара. base_unit — колонка NOT NULL со значением по
// умолчанию 'pcs' (мигр. 010): у товара, заведённого только с unit, в ней
// стоит это умолчание, а не его единица. Поэтому 'pcs' (или пусто) при
// заполненном unit читается как «base_unit не задавали», и показывается unit;
// в остальных случаях — base_unit, как на экранах склада.
const STOCK_UNIT_SQL = `CASE WHEN COALESCE(pr.base_unit, '') IN ('', 'pcs') AND COALESCE(pr.unit, '') <> ''
                             THEN pr.unit ELSE COALESCE(pr.base_unit, '') END`;

// PROCUREMENT_FILTERS_V1 (2026-09-25) — КАТЕГОРИЯ ЗАКУПОК у всех четырёх видов.
// Аргумент `category`: 'all' (или пусто) — все товары, иначе ОДНА категория
// из products.procurement_category (список и проверка — rpc/expiry.js, один на
// экран и отчёт). Отбор идёт в SQL по товару строки, поэтому строки, итоги по
// поставщикам, итог здания и сверка ведомости считаются по одной и той же
// выборке. Конструктор отчётов рисует фильтры переключателями с одним выбором —
// отсюда одна категория, а не список.
const CATEGORY_RU = {
  medicines: 'Медикаменты', consumables: 'Расходники', equipment: 'Оборудование',
  lab_supplies: 'Лаб. материалы', dental: 'Стоматология', radiology: 'Радиология',
  office_it: 'Офис / IT', facility: 'Хозяйство',
};
function reportCategory(args) {
  const v = args && args.category;
  if (v === undefined || v === null || v === '' || v === 'all') return null;
  if (Array.isArray(v)) throw new RpcError('category: одна категория или all.', 400);
  return parseCategories(v, 'category');
}
/** `AND pr.procurement_category IN (?)` — или пусто, если категория не выбрана. */
function categoryAnd(cats, col = 'pr.procurement_category') {
  const c = categoryClause(cats, col);
  return c ? { clause: ' AND ' + c.sql, params: c.params } : { clause: '', params: [] };
}
/** Примечание «в отчёте только категория …» — над таблицей, словами. */
function categoryNote(cats) {
  if (!cats) return null;
  return 'Категория: ' + cats.map((c) => '«' + (CATEGORY_RU[c] || c) + '»').join(', ')
    + ' — товары других категорий в отчёт и итоги не вошли.';
}

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
  const cats = reportCategory(args);
  const cf = categoryAnd(cats);
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
       AND ${inLocalRange('sm.created_at')}${bf.clause}${gf.clause}${cf.clause}
     ORDER BY sup.name IS NULL, sup.name, sm.created_at DESC, sm.id DESC
  `).all(from, to, ...bf.params, ...gf.params, ...cf.params);
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
    notes: [STOCK_LOCAL_NOTE, categoryNote(cats), ...totals].filter(Boolean),
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
// Ревью M4 — выданное на руки потом расходуется на пациентов ИЗ РУК: сложить
// «выдано» и «израсходовано» — значит посчитать один и тот же товар дважды.
// Поэтому это две колонки с двумя итогами, и общей «суммы расхода» нет.
const CONSUMPTION_SPLIT_NOTE = '«Выдано на руки» и «Израсходовано на пациентов» — два разных итога, их нельзя складывать: выданное на руки затем расходуется на пациентов из рук, и в сумме оно посчиталось бы дважды. Расход склада за период — «Израсходовано на пациентов» плюс то, что ещё лежит на руках.';

function consumptionMovements(db, args, ctx) {
  const { from, to } = resolveRange(db, args);
  const gf = buildingWhere(db, ctx, args, 'stock_movements', 'm');
  const cf = categoryAnd(reportCategory(args));
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
       AND ${inLocalRange('m.created_at')}${gf.clause}${cf.clause}
     ORDER BY m.created_at, m.id
  `).all(...refs, from, to, ...gf.params, ...cf.params).map((r) => {
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
  const notes = [STOCK_LOCAL_NOTE, categoryNote(reportCategory(args)), CONSUMPTION_NOTE, CONSUMPTION_SPLIT_NOTE].filter(Boolean);
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
      columns: [BUILDING_COL, 'Получатель / откуда', 'Движений', 'Выдано на руки (себестоимость)', 'Израсходовано на пациентов (себестоимость)'],
      rows: list.map((b) => [ctx.label(b.origin), b.holder, b.lines, round2(b.issued), round2(b.used)]),
      // Итог здания — израсходованное на пациентов; выданное на руки — не
      // расход, а перемещение (M4).
      by_building: summariseByBuilding(ctx, list, { total: (b) => b.used }),
      total_label: 'Израсходовано на пациентов',
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
      columns: [BUILDING_COL, 'Пациент', 'Движений', 'Израсходовано на пациентов (себестоимость)'],
      rows: list.map((b) => [ctx.label(b.origin), b.patient, b.lines, round2(b.sum)]),
      by_building: summariseByBuilding(ctx, list, { total: (b) => b.sum }),
      total_label: 'Себестоимость',
      notes: [...notes, 'Строка визита, удалённая вместе с отменой расхода, пациента уже не называет: такие движения собраны под «Пациент не определён» и в сумме гасят друг друга.'],
    };
  }
  return {
    columns: [BUILDING_COL, 'Дата', 'Вид', 'Товар', 'Кол-во', 'Ед.', 'Себестоимость ед.',
              'Выдано на руки (себестоимость)', 'Израсходовано на пациентов (себестоимость)',
              'Получатель / откуда', 'Пациент', 'Кто провёл'],
    rows: mv.map((r) => [ctx.label(r.origin), r.date, CONSUMPTION_KIND_RU[r.kind], r.product, round2(r.qty), r.unit || '',
      round2(r.cost), r.kind === 'issue' ? round2(r.sum) : null, r.kind === 'issue' ? null : round2(r.sum),
      r.holder, r.patient || '', r.actor || '']),
    by_building: summariseByBuilding(ctx, mv, { total: (r) => (r.kind === 'issue' ? 0 : r.sum) }),
    total_label: 'Израсходовано на пациентов',
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
  const cats = reportCategory(args);
  const catNote = categoryNote(cats);
  if (gf.clause.includes('1 = 0')) {
    return { columns: statementColumns(false), rows: [], by_building: summariseByBuilding(ctx, [], {}), total_label: 'Конец: сумма', notes: [STOCK_LOCAL_NOTE, catNote].filter(Boolean) };
  }
  // Категория отбирает ТОВАРЫ ведомости; сверка ниже сравнивает конец периода
  // с остатком в карточке тех же отобранных товаров — чужая категория в сверку
  // не попадает ни числом, ни словом.
  const cw = categoryClause(cats, 'pr.procurement_category');
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
     ${cw ? 'WHERE ' + cw.sql : ''}
     GROUP BY pr.id
     HAVING movements > 0 OR pr.on_hand <> 0
     ORDER BY pr.name, pr.id
  `).all(from, from, to, from, to, from, to, from, to, to, ...(cw ? cw.params : []));
  const checkNow = String(to).slice(0, 10) >= today(db);
  const list = rows.map((r) => {
    const closing = round2(r.opening + r.received - r.issued - r.used + r.adjusted);
    return { ...r, closing, diff: round2(closing - r.on_hand) };
  }).filter((r) => r.opening || r.received || r.issued || r.used || r.adjusted || r.closing || (checkNow && r.on_hand));
  const notes = [STOCK_LOCAL_NOTE, catNote, STATEMENT_NOTE].filter(Boolean);
  if (checkNow) {
    const bad = list.filter((r) => Math.abs(r.diff) > 1e-6);
    // Под фильтром «у всех товаров» было бы неправдой о складе целиком: сверены
    // только товары выбранной категории, и примечание так и говорит.
    const scope = cats ? ' выбранной категории' : '';
    notes.push(bad.length
      ? 'Сверка с карточкой товара: у ' + bad.length + ' ' + pluralRu(bad.length, 'товара', 'товаров', 'товаров') + scope
        + ' конечный остаток не совпадает с остатком в карточке — остаток меняли мимо журнала движений (колонка «Расхождение»).'
      : 'Сверка с карточкой товара: конечный остаток совпадает с остатком в карточке у всех товаров' + scope + '.');
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
  const cats = reportCategory(args);
  const catNote = categoryNote(cats);
  const day = today(db);
  const snapNote = 'Снимок на сегодня (' + day + '): период отчёта здесь не участвует. «Истекает» — срок в ближайшие ' + EXPIRING_SOON_DAYS + ' дней.';
  if (gf.clause.includes('1 = 0')) {
    return { columns: expiryColumns(), rows: [], by_building: summariseByBuilding(ctx, [], {}), total_label: 'Стоимость', notes: [STOCK_LOCAL_NOTE, catNote, EXPIRY_NOTE, snapNote].filter(Boolean) };
  }
  const cost = new Map(db.prepare('SELECT id, COALESCE(avg_cost, 0) AS avg_cost FROM products').all().map((p) => [p.id, p.avg_cost]));
  const lots = lotBalances(db, { categories: cats, todayStr: day })
    .filter((l) => (l.state === 'expired' || l.state === 'soon') && l.remaining > 1e-9)
    .sort((a, b) => (a.state === b.state ? (a.expiry_date < b.expiry_date ? -1 : a.expiry_date > b.expiry_date ? 1 : 0) : (a.state === 'expired' ? -1 : 1)));
  const list = lots.map((l) => ({ ...l, origin: '', cost: cost.get(l.product_id) || 0, value: l.remaining * (cost.get(l.product_id) || 0) }));
  return {
    columns: expiryColumns(),
    rows: list.map((l) => [ctx.label(''), EXPIRY_STATE_RU[l.state], l.product_name, l.product_code || '', l.batch_no || '',
      l.expiry_date, l.days_left, round2(l.remaining), l.unit || '', round2(l.cost), round2(l.value), l.supplier_name || '']),
    by_building: summariseByBuilding(ctx, list, { total: (l) => l.value }),
    total_label: 'Стоимость',
    notes: [STOCK_LOCAL_NOTE, catNote, EXPIRY_NOTE, snapNote].filter(Boolean),
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
    // PAY_BASIS_PERFORMED_V1 — это и есть доля строки (LINE_FEE_SQL), и она
    // ноль, пока операция не выполнена: одна формула, а не вторая копия здесь.
    const surgeonFee = r.doctor_fee || 0;
    // Расходники есть только у своего здания: движения склада не ездят.
    const products = r.visit_id != null ? (consumablesByVisit.get(r.visit_id) || 0) : 0;
    const profit = invoiced - tax - surgeonFee - products;
    return { origin: r.origin, doctor: r.doctor, invoiced, profit, row: [
      ctx.label(r.origin), r.patient, r.service, round2(invoiced), r.tax_rate, round2(tax),
      round2(surgeonFee), round2(products), round2(profit),
      invoiced > 0 ? round2(profit / invoiced * 100) : 0] };
  });
  const notes = [PERFORMED_NOTE, REVENUE_SHARE_NOTE, STOCK_LOCAL_NOTE];
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

// PAY_BASIS_PERFORMED_V1 — примечания отчётов, в которых есть доля врача.
// Первое — дословно то, что решил владелец; второе объясняет «выполнена» и
// «какая дата» словами экрана.
const PERFORMED_NOTE = 'Доля врача — по выполненным услугам, оплачены они или нет.';
const PERFORMED_BASIS_NOTE = 'Выполненная услуга — амбулаторная со статусом «взят материал», «в работе», «есть результат» или «завершена» (визит не отменён), стационарная — отмеченная «Выполнено». Период — по дню приёма, у стационара — по дню выполнения. Услуга без счёта считается по цене, которую выставит счёт, со скидкой категории пациента; строка отменённого счёта не считается.';
// Отчёты по выручке идут по СТРОКАМ СЧЕТОВ и по дате счёта — поэтому доля у
// них та же по правилу, но период другой.
const REVENUE_SHARE_NOTE = 'Строка счёта, услуга которой ещё не выполнена, доли врача не показывает. Период этого отчёта — по дате счёта; в «Зарплатах врачей» — по дню выполнения, поэтому за один период суммы долей могут различаться.';
// Решение владельца: вознаграждение за направления — только с оплаченного.
const REFERRAL_PAID_NOTE = 'Вознаграждение за направления — как и прежде, только по оплаченным счетам.';

function doctorSalariesReport(db, args, ctx) {
  const { from, to } = resolveRange(db, args);
  // BUILDING_REPORTS_V1 — приехавшая строка НЕ ОТБРАСЫВАЕТСЯ: у строки
  // соседнего здания врача нет и быть не может (карточки сотрудников между
  // зданиями не путешествуют), и она остаётся одной строкой на здание с
  // подписью «<здание>, врач не указан» (foreignPayRows).
  //
  // INPATIENT_SHARE_V1 — строки стационара идут СВОИМИ колонками; «Итого к
  // выплате» = амбулаторная доля + стационарная.
  //
  // PAY_BASIS_PERFORMED_V1 — строки — ВЫПОЛНЕННАЯ работа (performedPayLines),
  // оплачена она или нет; прежде — только полностью оплаченные счета периода.
  const lines = performedPayLines(db, { from, to, args, ctx, foreign: true });
  const groups = new Map();
  for (const r of lines) {
    const key = r.origin + '\u0000' + (r.doctor_id == null ? '' : r.doctor_id);
    let g = groups.get(key);
    if (!g) {
      g = { origin: r.origin, doctor: r.doctor, services_count: 0, after_discount: 0, pct_sum: 0, pct_n: 0,
            fixed_lines: 0, fee: 0, in_count: 0, in_after_discount: 0, in_fee: 0, in_norate: 0, unbilled: 0 };
      groups.set(key, g);
    }
    if (!r.invoiced) g.unbilled += 1;
    if (r.kind === 'in') {
      g.in_count += 1;
      g.in_after_discount += r.amount - r.discount;
      g.in_fee += r.doctor_fee;
      if (inpatientRateMissing(r)) g.in_norate += 1;
      continue;
    }
    g.services_count += 1;
    g.after_discount += r.amount - r.discount;
    // DOCTOR_FIX_RATE_V1 — средний % только по строкам с процентом; DOCTOR_TIER_V1 —
    // усредняется ДЕЙСТВУЮЩИЙ процент (со ступенью).
    if (r.fix == null) { g.pct_sum += r.pct; g.pct_n += 1; } else g.fixed_lines += 1;
    g.fee += r.doctor_fee;
  }
  // INPATIENT_BONUS_V1 — «За направление в стационар» (строки «Рефералов» со
  // стационара, которые идут врачу): своей колонкой ПОСЛЕ «Итого к выплате» и
  // в неё не входит — этот отчёт, как и прежде, про выплату за работу
  // (вознаграждение за амбулаторные направления в нём тоже не считается);
  // вся выплата со всеми вознаграждениями — в «По врачам» и в кабинете врача.
  // Врач, у которого в периоде только это вознаграждение, получает строку.
  const names = new Map(db.prepare('SELECT id, COALESCE(NULLIF(full_name, \'\'), username) AS n FROM users').all().map((u) => [u.id, u.n]));
  for (const r of inpatientReferralLines(db, { ...args, from, to, referrer: 'all' }, ctx)) {
    const docId = referralDoctorOf(r);
    if (docId == null || !r.reward) continue;
    const key = r.origin + '\u0000' + docId;
    let g = groups.get(key);
    if (!g) {
      g = { origin: r.origin, doctor: names.get(docId) || null, services_count: 0, after_discount: 0, pct_sum: 0, pct_n: 0,
            fixed_lines: 0, fee: 0, in_count: 0, in_after_discount: 0, in_fee: 0, in_norate: 0, unbilled: 0 };
      groups.set(key, g);
    }
    g.referral_in = (g.referral_in || 0) + r.reward;
  }
  const rows = [...groups.values()]
    // Ревью I1 (владелец: доля остаётся нулём, но об этом сказано): человек,
    // у которого в периоде только строки стационара БЕЗ его стационарной ставки
    // (медсестра нажала «Выполнить»), не показывается нулевой строкой — он
    // назван в примечании вместе с числом таких услуг.
    .filter((g) => g.referral_in || !(g.services_count === 0 && g.in_count > 0 && g.in_norate === g.in_count))
    .sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0)
      || (b.after_discount + b.in_after_discount) - (a.after_discount + a.in_after_discount));
  const noRate = inpatientNoRateNote(lines);
  return {
    columns: [BUILDING_COL, 'Врач', 'Выполненных услуг', 'Сумма после скидки', 'Средний % врача',
              'Услуг по фикс. ставке', 'Доля врача (гонорар)',
              'Стационар: услуг', 'Стационар: сумма после скидки', 'Стационар: гонорар', 'Итого к выплате',
              'Из них без счёта', 'За направление в стационар'],
    // Средний % пуст, когда все строки по фиксу: '—', а не 0 («работает даром»).
    rows: rows.map((r) => [ctx.label(r.origin), doctorCell(ctx, r) || '—', r.services_count,
      round2(r.after_discount),
      r.pct_n ? round2(r.pct_sum / r.pct_n) : '—', r.fixed_lines, round2(r.fee),
      r.in_count, round2(r.in_after_discount), round2(r.in_fee), round2(r.fee + r.in_fee), r.unbilled,
      round2(r.referral_in || 0)]),
    by_building: summariseByBuilding(ctx, rows, {
      total: (r) => (r.after_discount || 0) + (r.in_after_discount || 0),
      fee: (r) => (r.fee || 0) + (r.in_fee || 0),
    }),
    total_label: 'Сумма после скидки',
    notes: [PERFORMED_NOTE, PERFORMED_BASIS_NOTE,
      ...(hasUnattributed(ctx, rows) ? [UNATTRIBUTED_NOTE] : []), ...(noRate ? [noRate] : []),
      ...(rows.some((r) => r.referral_in) ? [INPATIENT_REFERRAL_PAY_NOTE] : [])],
  };
}
const INPATIENT_REFERRAL_PAY_NOTE = '«За направление в стационар» — вознаграждение направившему врачу госпитализации по вкладке «Стационар» его карточки: по оплаченным счетам госпитализации, по дате счёта, как в «Рефералах». В «Итого к выплате» этого отчёта не входит — полная выплата со всеми вознаграждениями в «По врачам».';

const INPATIENT_ROLE_RU = { performer: 'Исполнитель', ordering: 'Назначил' };

// INPATIENT_BONUS_V1 — у строки стационара нет ставки: ни процента, ни фикса
// на эту услугу во вкладке «Стационар» исполнителя (иначе назначившего).
function inpatientRateMissing(r) {
  return r.kind === 'in' && r.inpatient_pct == null && r.fix == null;
}
// «Ставка» строки стационара словами: процент, «фикс N» или прочерк.
function inpatientRateCell(r) {
  if (r.fix != null) return 'фикс ' + moneyRu(r.fix);
  return r.inpatient_pct == null ? '—' : round2(r.inpatient_pct);
}

// Ревью I1 — выполненные строки стационара, у исполнителя которых (иначе у
// назначившего) нет стационарной ставки на эту услугу: доля по ним не
// начислена НИКОМУ (решение владельца — так и оставить, но сказать). Одна
// строка примечания на три отчёта: «Стационар: доля врачей», «Зарплаты
// врачей», «По врачам». Считается по тем же строкам, что сама доля.
function inpatientNoRateNote(lines) {
  const none = lines.filter(inpatientRateMissing);
  if (!none.length) return null;
  const who = new Map();
  for (const r of none) who.set(r.doctor || '—', (who.get(r.doctor || '—') || 0) + 1);
  const list = [...who.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => n + ' — ' + c).join(', ');
  return none.length + ' ' + pluralRu(none.length, 'услуга', 'услуги', 'услуг')
    + ': исполнитель без стационарной ставки — доля не начислена (' + list + ').';
}

// Ревью I2 (владелец: исполнителя можно менять и после счёта) — отчёт идёт по
// ТЕКУЩЕМУ исполнителю строки.
const INPATIENT_CURRENT_PERFORMER_NOTE = 'Доля считается по текущему исполнителю строки: если исполнителя поменять после выставления счёта, доля перейдёт к новому.';

// «Оплата» строки словами: статус счёта, а у строки без счёта — «Нет счёта».
const payStateRu = (r) => (r.invoiced ? (INV_STATUS_RU[r.status] || r.status || '') : 'Нет счёта');

function inpatientShareReport(db, args, ctx) {
  const { from, to } = resolveRange(db, args);
  // PAY_BASIS_PERFORMED_V1 — выполненные строки стационара (с отметкой
  // «Выполнено»), со счётом или без; период — по дню выполнения.
  const src = performedPayLines(db, { from, to, kinds: ['in'], args, ctx });
  const noRate = inpatientNoRateNote(src);
  // Итоги по врачам — примечаниями над таблицей, по убыванию начисленного:
  // строка-подытог внутри таблицы попала бы и в общее «Итого» под ней.
  const perDoctor = new Map();
  for (const r of src) {
    const d = perDoctor.get(r.doctor_id) || { doctor: r.doctor || '—', lines: 0, net: 0, fee: 0 };
    d.lines += 1; d.net += r.net; d.fee += r.doctor_fee;
    perDoctor.set(r.doctor_id, d);
  }
  const totals = [...perDoctor.values()].sort((a, b) => b.fee - a.fee || b.net - a.net)
    .map((d) => 'Итого — ' + d.doctor + ': ' + d.lines + ' '
      + pluralRu(d.lines, 'строка', 'строки', 'строк') + ', после скидки и налога '
      + moneyRu(d.net) + ' сум, начислено ' + moneyRu(d.fee) + ' сум.');
  return {
    columns: [BUILDING_COL, 'Дата выполнения', '№ счёта', 'Оплата', 'Пациент', '№ госпитализации', 'Услуга', 'Кол-во', 'Сумма',
              'Скидка', 'Налог', 'После скидки и налога', 'Врач', 'Чей врач', 'Ставка, %', 'Начислено врачу'],
    rows: src.map((r) => [ctx.label(r.origin), r.date, r.invoice || '', payStateRu(r), r.patient || '', r.admission_no || '',
      r.service || '', r.qty, round2(r.amount), round2(r.discount), round2(r.tax), round2(r.net),
      r.doctor || '—', INPATIENT_ROLE_RU[r.doctor_role],
      // Нет стационарной доли на услугу — прочерк, а не «0 %»: ноль читался бы
      // как решение клиники, а это отсутствие решения.
      inpatientRateCell(r), round2(r.doctor_fee)]),
    by_building: summariseByBuilding(ctx, src, {
      total: (r) => r.net || 0,
      fee: (r) => r.doctor_fee || 0,
    }),
    total_label: 'После скидки и налога',
    notes: [...totals, PERFORMED_NOTE, PERFORMED_BASIS_NOTE, ...(noRate ? [noRate] : []), INPATIENT_CURRENT_PERFORMER_NOTE],
  };
}

// INPATIENT_SHARE_V1 — стационарная часть для кабинета врача, теми же строками,
// что отчёт. PAY_BASIS_PERFORMED_V1 — кабинет теперь берёт всю выплату одним
// doctor_pay_summary; этот вызов остаётся для прежних клиентов и тех же строк.
// Ревью I6: свои начисления — врачу, чужие — «Оплате врачей» и администратору.
export function doctorInpatientShare(db, args, user) {
  const doctorId = Number(args && args.doctor_id);
  if (!Number.isInteger(doctorId) || doctorId <= 0) throw new RpcError('doctor_id must be a positive integer.', 400);
  assertCanSeeDoctorPay(db, user, doctorId);   // ревью I6
  const { from, to } = resolveRange(db, args);
  const rows = performedPayLines(db, { from, to, doctorId, kinds: ['in'] }).map((r) => ({
    date: r.date, invoice: r.invoice, patient: r.patient, admission_no: r.admission_no,
    service: r.service, qty: r.qty, net: round2(r.net),
    pct: r.inpatient_pct == null || r.fix != null ? null : round2(r.inpatient_pct),
    fix: r.fix == null ? null : round2(r.fix),   // INPATIENT_BONUS_V1
    fee: round2(r.doctor_fee), doctor_role: r.doctor_role, invoiced: r.invoiced,
  }));
  return {
    from, to, rows,
    count: rows.length,
    fee: round2(rows.reduce((n, r) => n + r.fee, 0)),
  };
}

// ---------------------------------------------------------------------------
// PAY_BASIS_PERFORMED_V1 — ВСЯ выплата врача за период для кабинета, ОДНИМ
// вызовом и теми же строками, что отчёты (performedPayLines): амбулаторная
// доля, стационарная доля и вознаграждение за направления (referralLines —
// как в «Рефералах» и doctor_referral_reward, по оплаченным счетам). Прежде
// кабинет считал амбулаторную долю в браузере по строкам визита по дате
// создания, не больше 500 строк, без ставки по умолчанию, — и его сумма
// расходилась с «Зарплатами врачей». Теперь браузер ничего не считает: строки
// приходят с долей, итоги — готовыми, и числа равны отчёту бит в бит
// (reports.pay-basis.test.js, тест равенства). Строк столько, сколько их
// есть: предела в 500 больше нет, потому что счёт идёт не в браузере.
// Права — как у прочих начислений: свои — врачу, чужие — «Оплате врачей».
// ---------------------------------------------------------------------------
export function doctorPaySummary(db, args, user) {
  const doctorId = Number(args && args.doctor_id);
  if (!Number.isInteger(doctorId) || doctorId <= 0) throw new RpcError('doctor_id must be a positive integer.', 400);
  assertCanSeeDoctorPay(db, user, doctorId);
  const { from, to } = resolveRange(db, args);
  const lines = performedPayLines(db, { from, to, doctorId });
  const part = (kind) => {
    const ls = lines.filter((r) => r.kind === kind);
    return {
      count: ls.length,
      unbilled: ls.filter((r) => !r.invoiced).length,
      amount: round2(ls.reduce((n, r) => n + (r.amount - r.discount), 0)),
      net: round2(ls.reduce((n, r) => n + r.net, 0)),
      fee: round2(ls.reduce((n, r) => n + r.doctor_fee, 0)),
    };
  };
  const outpatient = part('out');
  const inpatient = part('in');
  const referral = doctorReferralRows(db, { from, to, doctorId });
  // INPATIENT_BONUS_V1 — «За направление в стационар»: те же строки, что в
  // «Рефералах» и «По врачам», по оплаченным счетам госпитализаций.
  const inpatientReferral = doctorInpatientReferralRows(db, { from, to, doctorId });
  // Ставка по умолчанию из карточки: кабинету — чтобы прогресс ступени видел и
  // врача без личной ставки на услугу (браузеру эта колонка не выдаётся).
  const doc = db.prepare('SELECT service_rate_default FROM users WHERE id = ?').get(doctorId);
  return {
    from, to,
    rate_default: doc ? Number(doc.service_rate_default) || 0 : 0,
    outpatient, inpatient,
    referral,
    inpatient_referral: inpatientReferral,
    total: round2(outpatient.fee + inpatient.fee + referral.reward + inpatientReferral.reward),
    lines: lines.map((r) => ({
      kind: r.kind, id: r.line_id, date: r.date, status: r.line_status,
      visit_id: r.visit_id, admission_no: r.admission_no,
      patient: r.patient || '', mrn: r.mrn || '',
      service_id: r.service_id, service: r.service || '', qty: r.qty,
      amount: round2(r.amount), discount: round2(r.discount), tax: round2(r.tax), net: round2(r.net),
      pct: r.kind === 'in' ? (r.inpatient_pct == null || r.fix != null ? null : round2(r.inpatient_pct)) : round2(r.pct),
      fix: r.fix == null ? null : round2(r.fix),
      fee: round2(r.doctor_fee),
      tier: Number(r.tier_units_above) > 0,
      invoiced: r.invoiced, invoice: r.invoice || '', invoice_status: r.status || null,
      doctor_role: r.doctor_role || null,
    })),
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

// Ревью M7 — «Оплачено» строки: оплата СЧЁТА, разнесённая на строки
// пропорционально сумме строки после скидки (paid_amount × строка / итог
// счёта, не больше самой строки). У частично оплаченного счёта прежде стоял 0 —
// как будто денег не было. Доли врача по-прежнему начисляются только по
// ПОЛНОСТЬЮ оплаченным счетам — это правило выплаты, а не колонки.
function linePaid(r) {
  const after = (r.amount || 0) - (r.discount || 0);
  const total = Number(r.inv_total) || 0;
  if (total <= 0) return r.status === 'paid' ? after : 0;
  const share = Math.max(0, Math.min(1, (Number(r.inv_paid) || 0) / total));
  return after * share;
}
// PAY_BASIS_PERFORMED_V1 — «Оплачено» остаётся колонкой СВЕДЕНИЙ: доля врача
// от оплаты больше не зависит.
const LINE_PAID_NOTE = '«Оплачено (доля оплаты счёта)» — оплата счёта, разнесённая по его строкам пропорционально сумме строки; у частично оплаченного счёта это часть строки. Это сведения: доля врача от оплаты не зависит.';

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
    b.paid += linePaid(r);   // ревью M7
    buckets.set(key, b);
  }
  const order = (g) => { const i = CAT_ORDER.indexOf(g); return i < 0 ? CAT_ORDER.length : i; };
  const list = [...buckets.values()].sort((a, b) =>
    (ctx.keyOf(a.origin) < ctx.keyOf(b.origin) ? -1 : ctx.keyOf(a.origin) > ctx.keyOf(b.origin) ? 1 : 0)
    || order(a.group) - order(b.group) || b.gross - a.gross);
  const notes = [PERFORMED_NOTE, REVENUE_SHARE_NOTE, LINE_PAID_NOTE];
  if (hasUnattributed(ctx, src)) notes.push(UNATTRIBUTED_NOTE);
  return {
    columns: [BUILDING_COL, 'Группа', 'Услуга', 'Где', 'Кол-во', 'Сумма', 'Скидка', 'Налог',
              'После скидки и налога', 'Доля врача', 'Остаток клинике', 'Оплачено (доля оплаты счёта)'],
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
// PAY_BASIS_PERFORMED_V1 — строки те же, что у «Зарплат врачей»: выполненная
// работа периода (performedPayLines), и доли в сумме равны им бит в бит.
// «Выставлено» и «Оплачено» — сведения по счетам этих услуг.
const DOCTOR_PAY_NOTE = 'Работа (пациенты, визиты, услуги) и доли врача — по выполненным услугам периода, как в «Зарплатах врачей». «Выставлено» и «Оплачено» — по счетам этих услуг, для сведения. «Вознаграждение за направления» — по внутреннему источнику врача, как в отчёте «Рефералы»; «За направление в стационар» — врачу, направившему пациента на госпитализацию, по вкладке «Стационар» его карточки, тоже как в «Рефералах» (по оплаченным счетам госпитализации).';

// DOCTOR_LINES_SPECIALTY_V1 — фильтр «Врач» (doctor_id) у детализации и у
// «Врачей и услуг». Пусто или 'all' — все врачи; мусор — 400, а не молча все:
// «показали всех, хотя спрашивали одного» читалось бы как его цифры.
function doctorFilterArg(args) {
  const v = args && args.doctor_id;
  if (v === undefined || v === null || v === '' || v === 'all') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new RpcError('doctor_id must be a positive integer.', 400);
  return n;
}

// Строки врача: своя строка без врача не входит (как в «Зарплатах врачей»),
// строка соседнего здания без врача — входит под подписью здания.
// DOCTOR_LINES_SPECIALTY_V1 — doctorId сужает выборку в SQL (performedPayLines);
// строк соседнего здания у выбранного врача нет — у них врача нет вовсе.
function doctorLines(db, args, ctx, doctorId = null) {
  const { from, to } = resolveRange(db, args);
  const lines = performedPayLines(db, { from, to, doctorId, args, ctx, foreign: true })
    .filter((r) => r.doctor_id != null || ctx.keyOf(r.origin) !== ctx.ownKey);
  // Ревью I1 — тот, у кого в периоде только оплаченные строки стационара без
  // его стационарной ставки (медсестра нажала «Выполнить»), нулевой строкой не
  // показывается: он назван в примечании (inpatientNoRateNote), как в
  // «Зарплатах врачей».
  const noRateOnly = inpatientRateMissing;
  const keep = new Set();
  for (const r of lines) if (!noRateOnly(r)) keep.add(doctorKey(ctx, r.origin, r.doctor_id));
  return lines.filter((r) => keep.has(doctorKey(ctx, r.origin, r.doctor_id)));
}
function doctorNotes(db, args, ctx, lines, doctorId = null) {
  const { from, to } = resolveRange(db, args);
  // Примечание о строках без стационарной ставки — по ВСЕМ строкам периода
  // (doctorLines уже убрал людей, у которых других строк нет).
  const noRate = inpatientNoRateNote(performedPayLines(db, { from, to, doctorId, kinds: ['in'], args, ctx }));
  const notes = [PERFORMED_NOTE, PERFORMED_BASIS_NOTE, DOCTOR_PAY_NOTE, REFERRAL_PAID_NOTE, LINE_PAID_NOTE];
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
        billed: 0, paid: 0, fee_out: 0, fee_in: 0, referral: 0, referral_in: 0,
      });
    }
    return buckets.get(key);
  };
  for (const r of lines) {
    const b = bucket(r.origin, r.doctor_id, r.doctor);
    const after = (r.amount || 0) - (r.discount || 0);
    b.patients.add(r.patient_id);
    if (r.kind === 'in') { if (r.admission_id != null) b.admissions.add(r.admission_id); }
    else if (r.visit_id != null) b.visits.add(r.visit_id);
    b.count += 1;
    // «Выставлено» — только то, что уже в счёте; строка без счёта в нём 0.
    if (r.invoiced) b.billed += after;
    b.paid += linePaid(r);   // ревью M7
    // PAY_BASIS_PERFORMED_V1 — доля выполненной строки, оплачена она или нет.
    if (r.kind === 'in') b.fee_in += r.doctor_fee || 0;
    else b.fee_out += r.doctor_fee || 0;
  }
  // Вознаграждение врача как направившего — только у внутренних источников,
  // связанных с сотрудником. Врач, который в периоде сам ничего не оказал, но
  // направлял, тоже получает строку: ему есть что платить.
  for (const r of referralLines(db, { ...args, referrer: 'all' }, ctx)) {
    if (r.referral_doctor_id == null || !r.reward) continue;
    bucket(r.origin, r.referral_doctor_id, null).referral += r.reward;
  }
  // INPATIENT_BONUS_V1 — «За направление в стационар»: строки «Рефералов» со
  // стационара, которые идут сотруднику (направивший врач госпитализации).
  for (const r of inpatientReferralLines(db, { ...args, referrer: 'all' }, ctx)) {
    const docId = referralDoctorOf(r);
    if (docId == null || !r.reward) continue;
    bucket(r.origin, docId, null).referral_in += r.reward;
  }
  const payOf = (b) => b.fee_out + b.fee_in + b.referral + b.referral_in;
  const list = [...buckets.values()].sort((a, b) =>
    (ctx.keyOf(a.origin) < ctx.keyOf(b.origin) ? -1 : ctx.keyOf(a.origin) > ctx.keyOf(b.origin) ? 1 : 0)
    || payOf(b) - payOf(a) || b.billed - a.billed);
  const notes = doctorNotes(db, args, ctx, lines);
  return {
    columns: [BUILDING_COL, 'Врач', 'Пациентов', 'Визитов', 'Госпитализаций', 'Услуг', 'Выставлено',
'Оплачено (доля оплаты счёта)', 'Доля за услуги', 'Стационарная доля', 'Вознаграждение за направления',
      'За направление в стационар', 'Итого к выплате'],
    rows: list.map((b) => [ctx.label(b.origin), doctorCell(ctx, b) || '—', b.patients.size, b.visits.size,
      b.admissions.size, b.count, round2(b.billed), round2(b.paid), round2(b.fee_out), round2(b.fee_in),
      round2(b.referral), round2(b.referral_in), round2(payOf(b))]),
    by_building: summariseByBuilding(ctx, list, {
      total: (b) => b.billed,
      fee: payOf,
    }),
    total_label: 'Выставлено',
    notes,
  };
}

// Разбивка: врач × услуга × место. Сумма «Доля врача» по врачу равна «Доле за
// услуги» + «Стационарной доле» его строки в 'by_doctors'.
function doctorServicesReport(db, args, ctx) {
  const doctorId = doctorFilterArg(args);   // DOCTOR_LINES_SPECIALTY_V1
  const lines = doctorLines(db, args, ctx, doctorId);
  const buckets = new Map();
  for (const r of lines) {
    const where = r.kind === 'in' ? 'in' : 'out';
    const who = r.service_id != null ? 'id:' + r.service_id : 'nm:' + (r.service || '');
    const key = doctorKey(ctx, r.origin, r.doctor_id) + '\u0000' + who + '\u0000' + where;
    const b = buckets.get(key) || {
      origin: r.origin, doctor: r.doctor, service: r.service || '—', where,
      patients: new Set(), qty: 0, billed: 0, paid: 0, fee: 0,
    };
    const after = (r.amount || 0) - (r.discount || 0);
    b.patients.add(r.patient_id);
    b.qty += Number(r.qty) || 1;
    if (r.invoiced) b.billed += after;
    b.paid += linePaid(r);   // ревью M7
    b.fee += r.doctor_fee || 0;   // PAY_BASIS_PERFORMED_V1 — по выполненному
    buckets.set(key, b);
  }
  const list = [...buckets.values()].sort((a, b) =>
    (ctx.keyOf(a.origin) < ctx.keyOf(b.origin) ? -1 : ctx.keyOf(a.origin) > ctx.keyOf(b.origin) ? 1 : 0)
    || String(a.doctor || '').localeCompare(String(b.doctor || ''), 'ru') || b.billed - a.billed);
  const notes = doctorNotes(db, args, ctx, lines, doctorId);
  return {
    columns: [BUILDING_COL, 'Врач', 'Услуга', 'Где', 'Пациентов', 'Кол-во', 'Выставлено', 'Оплачено (доля оплаты счёта)', 'Доля врача'],
    rows: list.map((b) => [ctx.label(b.origin), doctorCell(ctx, b) || '—', b.service, WHERE_RU[b.where],
      b.patients.size, round2(b.qty), round2(b.billed), round2(b.paid), round2(b.fee)]),
    by_building: summariseByBuilding(ctx, list, { total: (b) => b.billed, fee: (b) => b.fee }),
    total_label: 'Выставлено',
    notes,
  };
}

// ---------------------------------------------------------------------------
// DOCTOR_LINES_SPECIALTY_V1 (владелец, 26.09) — «in the by-doctor report there
// should be the list of the services provided by the doctor one by one».
//
// «Детализация» — третий вид плитки «По врачам»: строка на КАЖДУЮ строку
// выплаты. Источник — тот же doctorLines, что у «Врачей» и «Врачей и услуг»
// (performedPayLines, PAY_BASIS_PERFORMED_V1), поэтому сумма «Доли врача» по
// врачу равна его доле в «По врачам», «Зарплатах врачей» и в кабинете
// (doctor_pay_summary) бит в бит (reports.doctor-lines.test.js). Дата — дата
// базы выплаты: день приёма, у стационара — день выполнения.
// ---------------------------------------------------------------------------
// «Ставка» строки словами: «30 %», «фикс 15 000»; у стационара без ставки — «—».
function payRateCell(r) {
  if (r.fix != null) return 'фикс ' + moneyRu(r.fix);
  if (r.kind === 'in') return r.inpatient_pct == null ? '—' : round2(r.inpatient_pct) + ' %';
  return round2(r.pct || 0) + ' %';
}
const DOCTOR_LINES_NOTE = 'Строка — одна выполненная услуга. «Сумма после скидки» — со скидкой счёта, а у строки без счёта — со скидкой категории пациента или пакета (большей из двух), как её выставит счёт. Сумма «Доли врача» по врачу равна его доле в виде «Врачи» и в «Зарплатах врачей».';

function doctorLinesReport(db, args, ctx) {
  const doctorId = doctorFilterArg(args);
  const lines = doctorLines(db, args, ctx, doctorId);
  const list = [...lines].sort((a, b) =>
    (ctx.keyOf(a.origin) < ctx.keyOf(b.origin) ? -1 : ctx.keyOf(a.origin) > ctx.keyOf(b.origin) ? 1 : 0)
    || String(a.doctor || '').localeCompare(String(b.doctor || ''), 'ru')
    || String(a.date || '').localeCompare(String(b.date || ''))
    || (a.kind === b.kind ? 0 : a.kind === 'out' ? -1 : 1)
    || (Number(a.line_id) || 0) - (Number(b.line_id) || 0));
  return {
    columns: [BUILDING_COL, 'Дата', 'Врач', 'Пациент', 'Карта', 'Услуга', 'Где', 'Кол-во',
              'Сумма после скидки', '№ счёта', 'Статус счёта', 'Оплачено (доля оплаты счёта)', 'Ставка', 'Доля врача'],
    rows: list.map((r) => [ctx.label(r.origin), r.date || '', doctorCell(ctx, r) || '—', r.patient || '', r.mrn || '',
      r.service || '—', WHERE_RU[r.kind === 'in' ? 'in' : 'out'], Number(r.qty) || 1,
      round2((r.amount || 0) - (r.discount || 0)), r.invoice || '', payStateRu(r), round2(linePaid(r)),
      payRateCell(r), round2(r.doctor_fee || 0)]),
    by_building: summariseByBuilding(ctx, list, {
      total: (r) => (r.amount || 0) - (r.discount || 0),
      fee: (r) => r.doctor_fee || 0,
    }),
    total_label: 'Сумма после скидки',
    notes: [DOCTOR_LINES_NOTE, ...doctorNotes(db, args, ctx, lines, doctorId)],
  };
}

// ---------------------------------------------------------------------------
// DOCTOR_LINES_SPECIALTY_V1 — «По специальностям» (kind 'by_specialty'):
// «which services are provided by which specialty and amount».
//
// Специальность — ОСНОВНАЯ у исполнителя (users.specialty — первая в карточке,
// MULTI_SPECIALTY_V1), через общий канонизатор (shared/specialty-list.js):
// «ЛОР» и «Оториноларинголог (ЛОР)» — одна группа. Строки — выполненная работа
// периода, та же база, что выплата врачу (performedPayLines), плюс выполненные
// строки БЕЗ врача — отдельной группой (доли у них нет). Подытоги по
// специальностям — примечаниями, как «Итоги по врачам» у стационарной доли:
// строка-подытог в таблице попала бы в «Итого» под ней второй раз.
// ---------------------------------------------------------------------------
const NO_DOCTOR_GROUP = 'Без врача (лаборатория и др.)';
const NO_SPECIALTY_GROUP = 'Специальность не указана';
const SPECIALTY_BASIS_NOTE = 'Специальность — основная у врача-исполнителя (первая в его карточке); старые названия («ЛОР», «Оториноларинголог (ЛОР)») собраны под одним. У стационара исполнитель — отметивший «Выполнено», иначе назначивший. Доля врача — по его ставкам, как в «Зарплатах врачей»; у строк без врача её нет.';

function bySpecialtyReport(db, args, ctx) {
  const { from, to } = resolveRange(db, args);
  const lines = performedPayLines(db, { from, to, args, ctx, foreign: true, withoutDoctor: true });
  const users = new Map(db.prepare("SELECT id, COALESCE(NULLIF(full_name, ''), username) AS name, specialty FROM users").all()
    .map((u) => [u.id, u]));
  const specOf = (r) => {
    if (r.doctor_id == null) return NO_DOCTOR_GROUP;
    const u = users.get(r.doctor_id);
    return specialtyGroupName(u && u.specialty) || NO_SPECIALTY_GROUP;
  };
  const buckets = new Map();
  const perSpec = new Map();
  const noSpecDoctors = new Map();
  for (const r of lines) {
    const spec = specOf(r);
    if (spec === NO_SPECIALTY_GROUP) {
      const u = users.get(r.doctor_id);
      noSpecDoctors.set(r.doctor_id, (u && u.name) || r.doctor || '—');
    }
    const where = r.kind === 'in' ? 'in' : 'out';
    const who = r.service_id != null ? 'id:' + r.service_id : 'nm:' + (r.service || '');
    const key = ctx.keyOf(r.origin) + '\u0000' + spec + '\u0000' + who + '\u0000' + where;
    const b = buckets.get(key) || {
      origin: r.origin, spec, service: r.service || '—', where,
      patients: new Set(), qty: 0, amount: 0, paid: 0, fee: 0,
    };
    const after = (r.amount || 0) - (r.discount || 0);
    b.patients.add(r.patient_id);
    b.qty += Number(r.qty) || 1;
    b.amount += after;
    b.paid += linePaid(r);
    b.fee += r.doctor_fee || 0;
    buckets.set(key, b);
    const t = perSpec.get(spec) || { spec, lines: 0, patients: new Set(), amount: 0, fee: 0 };
    t.lines += 1; t.patients.add(r.patient_id); t.amount += after; t.fee += r.doctor_fee || 0;
    perSpec.set(spec, t);
  }
  // Специальности по алфавиту; «не указана» и «без врача» — в конце.
  const rank = (spec) => (spec === NO_DOCTOR_GROUP ? 2 : spec === NO_SPECIALTY_GROUP ? 1 : 0);
  const bySpec = (a, b) => rank(a) - rank(b) || a.localeCompare(b, 'ru');
  const list = [...buckets.values()].sort((a, b) =>
    (ctx.keyOf(a.origin) < ctx.keyOf(b.origin) ? -1 : ctx.keyOf(a.origin) > ctx.keyOf(b.origin) ? 1 : 0)
    || bySpec(a.spec, b.spec) || b.amount - a.amount || (a.where === b.where ? 0 : a.where === 'out' ? -1 : 1));
  const totals = [...perSpec.values()].sort((a, b) => bySpec(a.spec, b.spec))
    .map((t) => 'Итого — ' + t.spec + ': ' + t.lines + ' ' + pluralRu(t.lines, 'услуга', 'услуги', 'услуг')
      + ', ' + t.patients.size + ' ' + pluralRu(t.patients.size, 'пациент', 'пациента', 'пациентов')
      + ', после скидки ' + moneyRu(t.amount) + ' сум, доля врачей ' + moneyRu(t.fee) + ' сум.');
  const notes = [...totals, SPECIALTY_BASIS_NOTE, PERFORMED_BASIS_NOTE, LINE_PAID_NOTE];
  if (noSpecDoctors.size) {
    const n = noSpecDoctors.size;
    notes.push('У ' + n + ' ' + pluralRu(n, 'врача', 'врачей', 'врачей') + ' не указана специальность ('
      + [...noSpecDoctors.values()].sort((a, b) => a.localeCompare(b, 'ru')).join(', ')
      + ') — их услуги в группе «' + NO_SPECIALTY_GROUP + '». Специальность задаётся в карточке сотрудника.');
  }
  if (hasUnattributed(ctx, lines)) notes.push(UNATTRIBUTED_NOTE);
  return {
    columns: [BUILDING_COL, 'Специальность', 'Услуга', 'Где', 'Кол-во', 'Пациентов',
              'Сумма после скидки', 'Оплачено (доля оплаты счёта)', 'Доля врача'],
    rows: list.map((b) => [ctx.label(b.origin), b.spec, b.service, WHERE_RU[b.where], round2(b.qty), b.patients.size,
      round2(b.amount), round2(b.paid), round2(b.fee)]),
    by_building: summariseByBuilding(ctx, list, { total: (b) => b.amount, fee: (b) => b.fee }),
    total_label: 'Сумма после скидки',
    notes,
  };
}

// DOCTOR_LINES_SPECIALTY_V1 — варианты фильтра-выпадающего списка хаба
// (option type 'select'): report_choices({ kind, arg }) → { choices: [[value,
// label]] }. За ТЕМИ ЖЕ воротами, что сам отчёт: кому «Оплата врачей» закрыта,
// тот и списка врачей отсюда не получит. Значение — строкой: так его хранит
// <select>, а сервер отчёта принимает и строку, и число.
const REPORT_CHOICES = {
  // Врачи — по is_doctor (у админа-врача роли 'doctor' нет) и все, у кого есть
  // строки работы: исполнитель стационара бывает и не врачом.
  doctor_id: (db) => db.prepare(`
    SELECT id, COALESCE(NULLIF(full_name, ''), username) AS name FROM users
     WHERE is_doctor = 1
        OR id IN (SELECT DISTINCT doctor_id FROM visit_services WHERE doctor_id IS NOT NULL)
        OR id IN (SELECT DISTINCT COALESCE(performer_id, doctor_id) FROM admission_services
                   WHERE COALESCE(performer_id, doctor_id) IS NOT NULL)
  `).all().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'))
    .map((u) => [String(u.id), u.name || '—']),
};
export function reportChoices(db, args, user) {
  const kind = args && args.kind;
  const arg = args && args.arg;
  if (!Object.prototype.hasOwnProperty.call(REPORTS_RU, kind)) throw new RpcError('unknown report kind: ' + kind, 400);
  if (!Object.prototype.hasOwnProperty.call(REPORT_CHOICES, arg)) throw new RpcError('unknown report option: ' + arg, 400);
  requireReportKind(db, user, kind);
  return { choices: REPORT_CHOICES[arg](db) };
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
  doctor_lines:     doctorLinesReport,       // DOCTOR_LINES_SPECIALTY_V1 — строка на услугу врача
  by_specialty:     bySpecialtyReport,       // DOCTOR_LINES_SPECIALTY_V1 — по специальностям
  // REPORTS_V2 — «Закупки и склад»: приход — 'procurement' выше.
  stock_consumption: stockConsumptionReport,
  stock_statement:   stockStatementReport,
  stock_expiry:      stockExpiryReport,
};

// OWNER_REPORT_V1 — chart data for «Отчёт владельца»: period KPIs, last-12-months
// revenue (independent of the selected period, like production), revenue by
// service (local schema has no service groups), receipts by payer kind.
const OWNER_M_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export function ownerReport(db, args, user) {
  requireReportKind(db, user, 'owner');   // ROLE_REPORTS_SETTINGS_V1 — «Выручка и счета»
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
  'doctor_lines', 'by_specialty',                   // DOCTOR_LINES_SPECIALTY_V1
]);

export function runReport(db, args, user) {
  const kind = args && args.kind;
  const ru = REPORTS_RU[kind];
  // ROLE_REPORTS_SETTINGS_V1 — группа вида: неизвестный вид остаётся 400
  // (ниже), известный проверяется ДО того, как что-нибудь посчитано.
  if (ru || Object.prototype.hasOwnProperty.call(legacyReports(db), kind)) requireReportKind(db, user, kind);
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
// ROLE_REPORTS_SETTINGS_V1 — читает сам врач или тот, кому открыта «Оплата
// врачей» (assertCanSeeDoctorPay). Прежде — любой вошедший по любому номеру
// врача: нумерация строк за порогом — это те же чужие начисления, что
// doctor_inpatient_share и doctor_referral_reward, закрытые ревью I6.
// Пусто — у врача в этих месяцах нет строк по услугам со ступенью.
const TIER_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export function doctorTierPositions(db, args, user) {
  const doctorId = Number(args && args.doctor_id);
  if (!Number.isInteger(doctorId) || doctorId <= 0) throw new RpcError('doctor_id must be a positive integer.', 400);
  assertCanSeeDoctorPay(db, user, doctorId);
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
