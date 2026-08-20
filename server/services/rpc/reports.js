// Reporting RPCs — read-only. /api/db can't do SUM/GROUP BY/date-range
// filters on most tables, so both the period-overview KPIs and the tabular
// date-range reports are computed here from raw rows. Any authenticated
// user may call these (requireAuth is applied by the route; no extra role
// gate needed — see server/routes/rpc.js).

import { today, localDate, localMonth, inLocalRange } from '../domain/day.js';
import { outstandingWhere } from '../domain/money.js';
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

export function reportsOverview(db, args, _user) {
  const { from, to } = resolveRange(db, args);
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const cash_collected = one(
    // DEPOSIT_REVENUE_V1 — платежи «кошельком» уже посчитаны выручкой в день
    // приёма депозита; второй раз их считать нельзя.
    `SELECT COALESCE(SUM(amount),0) s FROM payments WHERE ${INFLOW_SQL} AND ${inLocalRange('paid_at')}`,
    from, to
  ).s;
  const invoices_created = one(
    `SELECT COUNT(*) n FROM invoices WHERE ${inLocalRange('created_at')}`,
    from, to
  ).n;
  const patients_new = one(
    `SELECT COUNT(*) n FROM patients WHERE ${inLocalRange('created_at')}`,
    from, to
  ).n;
  const visits_count = one(
    `SELECT COUNT(*) n FROM visits WHERE ${inLocalRange('visit_date')}`,
    from, to
  ).n;
  // All-time (not range-limited): what's currently owed across all open invoices.
  const outstanding_total = one(
    `SELECT COALESCE(SUM(total_amount - paid_amount),0) s FROM invoices WHERE ${outstandingWhere()}`
  ).s;

  return {
    cash_collected: round2(cash_collected),
    invoices_created,
    patients_new,
    visits_count,
    outstanding_total: round2(outstanding_total),
    from,
    to,
  };
}

const REPORTS = {
  payments: {
    columns: ['Date', 'Patient', 'Invoice', 'Amount', 'Method', 'Cashier'],
    sql: `
      SELECT ${localDate('p.paid_at')} AS date,
             pt.full_name           AS patient,
             i.invoice_number       AS invoice,
             p.amount                AS amount,
             p.method                AS method,
             u.full_name             AS cashier
        FROM payments p
        JOIN invoices i ON i.id = p.invoice_id
        JOIN patients pt ON pt.id = i.patient_id
        LEFT JOIN users u ON u.id = p.cashier_id
       WHERE ${inLocalRange('p.paid_at')}
       ORDER BY p.paid_at
    `,
    row: (r) => [r.date, r.patient, r.invoice, round2(r.amount), r.method, r.cashier || ''],
  },
  invoices: {
    columns: ['Invoice #', 'Date', 'Patient', 'Total', 'Paid', 'Balance', 'Status'],
    sql: `
      SELECT i.invoice_number AS invoice_number,
             ${localDate('i.created_at')} AS date,
             pt.full_name AS patient,
             i.total_amount AS total,
             i.paid_amount AS paid,
             (i.total_amount - i.paid_amount) AS balance,
             i.status AS status
        FROM invoices i
        JOIN patients pt ON pt.id = i.patient_id
       WHERE ${inLocalRange('i.created_at')}
       ORDER BY i.created_at
    `,
    row: (r) => [r.invoice_number, r.date, r.patient, round2(r.total), round2(r.paid), round2(r.balance), r.status],
  },
  services: {
    columns: ['Service', 'Qty', 'Revenue'],
    sql: `
      SELECT s.name AS service,
             SUM(ii.quantity) AS qty,
             SUM(ii.total) AS revenue
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        JOIN services s ON s.id = ii.service_id
       WHERE ${inLocalRange('i.created_at')}
       GROUP BY s.id, s.name
       ORDER BY revenue DESC
    `,
    row: (r) => [r.service, r.qty, round2(r.revenue)],
  },
  visits: {
    columns: ['Date', 'Patient', 'Doctor', 'Type', 'Status'],
    sql: `
      SELECT ${localDate('v.visit_date')} AS date,
             pt.full_name AS patient,
             u.full_name AS doctor,
             v.visit_type AS type,
             v.status AS status
        FROM visits v
        JOIN patients pt ON pt.id = v.patient_id
        LEFT JOIN users u ON u.id = v.doctor_id
       WHERE ${inLocalRange('v.visit_date')}
       ORDER BY v.visit_date
    `,
    row: (r) => [r.date, r.patient, r.doctor || '', r.type, r.status],
  },
  patients: {
    columns: ['MRN', 'Name', 'Gender', 'Registered'],
    sql: `
      SELECT mrn, full_name, gender, ${localDate('created_at')} AS registered
        FROM patients
       WHERE ${inLocalRange('created_at')}
       ORDER BY created_at
    `,
    row: (r) => [r.mrn, r.full_name, r.gender, r.registered],
  },
  stock_movements: {
    columns: ['Date', 'Product', 'Type', 'Qty', 'Unit cost'],
    sql: `
      SELECT ${localDate('sm.created_at')} AS date,
             pr.name AS product,
             sm.kind AS kind,
             sm.qty AS qty,
             sm.unit_cost AS unit_cost,
             sm.id AS id
        FROM stock_movements sm
        JOIN products pr ON pr.id = sm.product_id
       WHERE ${inLocalRange('sm.created_at')}
       ORDER BY sm.id DESC
    `,
    row: (r) => [r.date, r.product, r.kind, r.qty, r.unit_cost == null ? null : round2(r.unit_cost)],
  },
};

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

function itemRowsQuery(db, args) {
  const { from, to } = resolveRange(db, args);
  const bf = branchFilter(args, 'i.branch_id');
  const rows = db.prepare(`
    SELECT ${localDate('i.created_at')}       AS date,
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
       AND i.status <> 'void'${bf.clause}
     ORDER BY i.created_at, ii.id
  `).all(from, to, ...bf.params);
  return rows;
}

function totalRevenueReport(db, args) {
  return {
    columns: ['Дата', '№ счёта', 'Пациент', 'МРН', 'Услуга', 'Кол-во', 'Цена', 'Сумма',
              'Скидка', 'После скидки', 'Налог %', 'Налог', 'Врач', 'Ставка врача', 'Доля врача',
              'Филиал', 'Регистратор', 'Реферал', 'Статус'],
    rows: itemRowsQuery(db, args).map((r) => {
      const after = r.amount - r.discount;
      // DOCTOR_FIX_RATE_V1 — the rate column states WHICH rate applied. Printing
      // a percentage for a fixed-rate line would read as "this doctor gets 0%"
      // next to a non-zero fee.
      const rate = r.doctor_fix != null ? ('фикс ' + round2(r.doctor_fix)) : r.doctor_pct;
      return [r.date, r.invoice || '', r.patient, r.mrn || '', r.service || '', r.qty,
              round2(r.price), round2(r.amount), round2(r.discount), round2(after),
              r.tax_rate, round2(after * r.tax_rate / 100), r.doctor || '', rate,
              round2(r.doctor_fee), r.branch || '', r.registrar || '',
              r.referral || '', INV_STATUS_RU[r.status] || r.status];
    }),
  };
}

function referralsReport(db, args) {
  const rewards = db.prepare('SELECT name, percent FROM referral_rewards WHERE active = 1').all();
  const rewardByName = new Map(rewards.map((r) => [r.name.trim().toLowerCase(), r.percent]));
  const buckets = new Map();
  for (const r of itemRowsQuery(db, args)) {
    if (!r.referral) continue;
    const b = buckets.get(r.referral) || {
      source: r.referral, category: r.referral_category || '', count: 0, amount: 0,
    };
    b.count += 1;
    b.amount += r.amount - r.discount;
    buckets.set(r.referral, b);
  }
  const rows = [...buckets.values()]
    .sort((a, b) => b.amount - a.amount)
    .map((b) => {
      // «Вручную» — a reward rate named exactly like the source; «Общий» — a
      // rate named like the source's category; otherwise 0%.
      const own = rewardByName.get(b.source.trim().toLowerCase());
      const cat = rewardByName.get((b.category || '').trim().toLowerCase());
      const pct = own != null ? own : (cat != null ? cat : 0);
      const mode = own != null ? 'Вручную' : 'Общий';
      return [b.source, b.category, mode, b.count, round2(b.amount), pct, round2(b.amount * pct / 100)];
    });
  return {
    columns: ['Источник', 'Категория', 'Режим ставок', 'Услуг', 'Сумма услуг', '% вознаграждения', 'Вознаграждение'],
    rows,
  };
}

function invoicesFullReport(db, args) {
  const { from, to } = resolveRange(db, args);
  const bf = branchFilter(args, 'i.branch_id');
  const rows = db.prepare(`
    SELECT i.invoice_number AS number, ${localDate('i.created_at')} AS created,
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
     WHERE ${inLocalRange('i.created_at')}${bf.clause}
     ORDER BY i.created_at DESC
  `).all(from, to, ...bf.params);
  return {
    columns: ['№ счёта', 'Дата', 'Пациент', 'МРН', 'Телефон', 'Филиал', 'Кто платит',
              'Сумма без скидки', 'Скидка', 'Итого', 'Оплачено', 'Остаток / долг',
              'Статус', 'Способ оплаты', 'Дата оплаты', 'Регистратор'],
    rows: rows.map((r) => [r.number || '', r.created, r.patient, r.mrn || '', r.phone || '',
      r.branch || '', r.payer || 'Пациент', round2(r.subtotal), round2(r.discount),
      round2(r.total), round2(r.paid), round2(Math.max(r.total - r.paid, 0)),
      INV_STATUS_RU[r.status] || r.status,
      // GROUP_CONCAT возвращает "cash,card" одной строкой — режем и отдаём в
      // общий с браузером словарь, чтобы оба отчёта «Счета» называли один и тот
      // же платёж одинаково.
      formatMethods(String(r.methods || '').split(',')),
      r.paid_at || '', r.registrar || '']),
  };
}

function procurementReport(db, args) {
  const { from, to } = resolveRange(db, args);
  const bf = branchFilter(args, 'sm.branch_id');
  const rows = db.prepare(`
    SELECT ${localDate('sm.created_at')} AS date, pr.name AS product, sm.note AS note,
           sm.qty AS qty, sm.unit_cost AS unit_cost
      FROM stock_movements sm
      JOIN products pr ON pr.id = sm.product_id
     WHERE sm.kind = 'receive'
       AND ${inLocalRange('sm.created_at')}${bf.clause}
     ORDER BY sm.created_at DESC
  `).all(from, to, ...bf.params);
  return {
    columns: ['Дата', 'Товар', 'Поставщик / примечание', 'Количество', 'Цена за ед.', 'Сумма'],
    rows: rows.map((r) => [r.date, r.product, r.note || '', r.qty,
      r.unit_cost == null ? null : round2(r.unit_cost),
      round2(r.qty * (r.unit_cost || 0))]),
  };
}

const SURGERY_RE = /хирург|операц|surg|operat/i;

function surgeryProfitReport(db, args) {
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
  const rows = itemRowsQuery(db, args)
    .filter((r) => SURGERY_RE.test(r.service || ''))
    .map((r) => {
      const invoiced = r.amount - r.discount;
      const tax = invoiced * r.tax_rate / 100;
      // DOCTOR_SHARE_AFTER_TAX_V1 — гонорар хирурга считается от суммы ПОСЛЕ
      // налога, как и доля врача везде. Здесь это было особенно заметно: строкой
      // ниже налог вычитается из прибыли клиники, то есть один и тот же налог
      // клиника «отдавала» дважды — государству и в базу гонорара.
      // Фиксированную ставку (если она задана на услугу) берём из общего
      // расчёта: она за единицу и налогом не режется.
      const surgeonFee = r.doctor_fix != null ? r.doctor_fee : (invoiced - tax) * r.doctor_pct / 100;
      const products = r.visit_id != null ? (consumablesByVisit.get(r.visit_id) || 0) : 0;
      const profit = invoiced - tax - surgeonFee - products;
      return [r.patient, r.service, round2(invoiced), r.tax_rate, round2(tax),
              round2(surgeonFee), round2(products), round2(profit),
              invoiced > 0 ? round2(profit / invoiced * 100) : 0];
    });
  return {
    columns: ['Пациент', 'Операция', 'Сумма по счёту', 'Ставка налога (%)', 'Налог',
              'Гонорар хирурга', 'Расходники (товары)', 'Прибыль клиники', 'Маржа (%)'],
    rows,
  };
}

function doctorSalariesReport(db, args) {
  const { from, to } = resolveRange(db, args);
  const bf = branchFilter(args, 'i.branch_id');
  const rows = db.prepare(`
    SELECT doc.full_name AS doctor,
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
       AND vs.doctor_id IS NOT NULL
       AND ${inLocalRange('i.created_at')}${bf.clause}
     GROUP BY vs.doctor_id
     ORDER BY after_discount DESC
  `).all(from, to, ...bf.params);
  return {
    columns: ['Врач', 'Оплаченных услуг', 'Сумма после скидки', 'Средний % врача',
              'Услуг по фикс. ставке', 'Доля врача (гонорар)'],
    // avg_pct is NULL when every line was fixed-rate — print '—' rather than 0,
    // which would claim the doctor works for nothing.
    rows: rows.map((r) => [r.doctor, r.services_count, round2(r.after_discount),
      r.avg_pct == null ? '—' : round2(r.avg_pct), r.fixed_lines || 0, round2(r.fee)]),
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

  const base = `
    FROM invoice_items ii
    JOIN invoices i  ON i.id = ii.invoice_id
    JOIN patients pt ON pt.id = i.patient_id
    LEFT JOIN payers py ON py.id = pt.payer_id
    LEFT JOIN services s ON s.id = ii.service_id
   WHERE i.status <> 'void'${bf.clause}`;

  const k = db.prepare(`
    SELECT COALESCE(SUM(ii.total - ${ITEM_DISCOUNT_SQL}), 0) AS revenue, COUNT(ii.id) AS count
    ${base} AND ${inLocalRange('i.created_at')}
  `).get(...bf.params, from, to);

  const byGroupRaw = db.prepare(`
    SELECT COALESCE(s.name, ii.description) AS name,
           SUM(ii.total - ${ITEM_DISCOUNT_SQL}) AS value
    ${base} AND ${inLocalRange('i.created_at')}
     GROUP BY COALESCE(s.name, ii.description)
     ORDER BY value DESC
  `).all(...bf.params, from, to);
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
  `).all(...bf.params, monthly[0].key)) {
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
  `).all(...bf.params, from, to)) {
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

  return {
    kpis: {
      revenue: Math.round(k.revenue),
      count: k.count,
      avg: k.count ? Math.round(k.revenue / k.count) : 0,
    },
    monthly, byGroup, byPayer, from, to,
  };
}

export function runReport(db, args, _user) {
  const kind = args && args.kind;
  const ru = REPORTS_RU[kind];
  if (ru) {
    const { columns, rows } = ru(db, args);
    return { kind, columns, rows };
  }
  const report = REPORTS[kind];
  if (!report) {
    throw new RpcError('unknown report kind: ' + kind, 400);
  }
  const { from, to } = resolveRange(db, args);

  const rows = db.prepare(report.sql).all(from, to).map(report.row);
  return { kind, columns: report.columns, rows };
}
