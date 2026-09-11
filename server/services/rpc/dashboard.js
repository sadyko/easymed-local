// Dashboard summary RPC — read-only, today's-activity numbers for the admin
// landing page. No SELECT SUM/aggregate exists over /api/db, so this handler
// computes everything server-side from raw rows. Any authenticated user may
// call it (requireAuth is applied by the route; no extra role gate needed —
// see server/routes/rpc.js).
//
// BUILDING_REPORTS_V1 — сводка считает КЛИНИКУ и рядом отдаёт разрез по
// зданиям. До этого фильтра не было вовсе, и это давало обе ошибки сразу:
// «Пациентов сегодня» и «Визитов сегодня» молча складывали своё здание с
// приехавшими строками (число росло, а в списках под ним столько записей не
// было), а деньги приехать не могли — значит, выручка второго здания в сводке
// просто отсутствовала. Теперь каждая плитка знает, из чего она сложена.

import { isLocalToday, today, localDate, inLocalRange } from '../domain/day.js';
import { outstandingWhere } from '../domain/money.js';
import { INFLOW_SQL } from '../../../public/js/shared/payment-methods.js';   // DEPOSIT_REVENUE_V1
// LAB_ONE_CLINIC_V1 — границу лаборатории задаёт ОДНА функция, общая с экраном
// (views/lab-scope.js через domain/buildings.js). Импортируем правило, а не
// переписываем его: плитка и очередь под ней обязаны одинаково отвечать на
// вопрос «чьи это пробирки», а два одинаковых условия в разных файлах — это два
// условия, которые однажды разойдутся. Ровно это здесь и произошло.
import {
  buildingContext, originExpr, summariseByBuilding, labScopeOf, labScopeWhere,
} from '../domain/buildings.js';
// DASHBOARD_TREND_V1 — «кто лежит» решает тот же список статусов, что и все
// экраны стационара: своя копия здесь разошлась бы с ним при первой правке.
import { IN_BED_STATUSES } from '../../../public/js/shared/admission-status.js';

export function dashboardSummary(db, _args, _user) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const ctx = buildingContext(db);

  // "Today" is the LOCAL clinic day, matching the till — see domain/day.js.
  const patients = all(`SELECT ${originExpr(db, 'patients', 'p')} AS origin, COUNT(*) n
      FROM patients p WHERE ${isLocalToday('p.created_at')} GROUP BY origin`);
  const visits = all(`SELECT ${originExpr(db, 'visits', 'v')} AS origin, COUNT(*) n
      FROM visits v WHERE ${isLocalToday('v.visit_date')} GROUP BY origin`);
  // DEPOSIT_REVENUE_V1 — без «кошелька»: это трата уже принятого депозита, а не
  // новые деньги в кассе.
  const collected = all(`SELECT ${originExpr(db, 'payments', 'p')} AS origin, COALESCE(SUM(p.amount),0) s
      FROM payments p WHERE ${INFLOW_SQL} AND ${isLocalToday('p.paid_at')} GROUP BY origin`);
  const outstanding = all(`SELECT ${originExpr(db, 'invoices', 'i')} AS origin, COUNT(*) n,
             COALESCE(SUM(i.total_amount - i.paid_amount),0) s
      FROM invoices i WHERE ${outstandingWhere('i.status')} GROUP BY origin`);
  // Склад между зданиями не ездит: остаток всегда свой, и разрез по зданиям
  // здесь был бы выдумкой.
  const low_stock_count = one("SELECT COUNT(*) n FROM products WHERE active=1 AND reorder_level>0 AND on_hand<=reorder_level").n;

  // LAB_ONE_CLINIC_V1 — плитка обязана считать ТУ ЖЕ ГРАНИЦУ, что показывает
  // лабораторная очередь под ней, а с миграции 085 эту границу задаёт
  // настройка doc_settings.lab_scope, а НЕ константа. Здесь стояло жёсткое
  // `AND vs.sync_origin IS NULL` с комментарием «как в очереди» — но очередь с
  // 0.7.0 по умолчанию клиниковая (views/laboratory.js накладывает границу
  // через scopeQuery), и комментарий описывал поведение, которого больше нет:
  // плитка показывала МЕНЬШЕ, чем список под ней, то есть ровно то
  // расхождение, ради которого условие когда-то и появилось.
  const labScope = labScopeOf(db);
  const labBuildingClause = labScopeWhere(db, labScope, 'visit_services', 'vs');
  const labRows = all(`SELECT ${originExpr(db, 'visit_services', 'vs')} AS origin, COUNT(*) n
      FROM visit_services vs
      JOIN services s ON s.id = vs.service_id
      WHERE s.is_lab=1 AND vs.status IN ('queued','in_progress')${labBuildingClause}
        AND NOT EXISTS (SELECT 1 FROM lab_results lr WHERE lr.visit_service_id=vs.id AND lr.verified_at IS NOT NULL)
      GROUP BY origin`);

  const merged = [
    ...patients.map((r) => ({ origin: r.origin, patients_today: r.n })),
    ...visits.map((r) => ({ origin: r.origin, visits_today: r.n })),
    ...collected.map((r) => ({ origin: r.origin, collected_today: r.s })),
    ...outstanding.map((r) => ({ origin: r.origin, outstanding_count: r.n, outstanding_amount: r.s })),
    ...labRows.map((r) => ({ origin: r.origin, lab_pending_count: r.n })),
  ];
  const buildings = summariseByBuilding(ctx, merged, {
    patients_today:     (r) => r.patients_today || 0,
    visits_today:       (r) => r.visits_today || 0,
    collected_today:    (r) => r.collected_today || 0,
    outstanding_count:  (r) => r.outstanding_count || 0,
    outstanding_amount: (r) => r.outstanding_amount || 0,
    lab_pending_count:  (r) => r.lab_pending_count || 0,
  }).map((b) => { const { rows: _rows, ...rest } = b; return rest; });

  const sum = (k) => buildings.reduce((n, b) => n + b[k], 0);
  return {
    patients_today: sum('patients_today'),
    visits_today: sum('visits_today'),
    collected_today: Math.round(sum('collected_today') * 100) / 100,
    outstanding_count: sum('outstanding_count'),
    outstanding_amount: Math.round(sum('outstanding_amount') * 100) / 100,
    low_stock_count,
    lab_pending_count: sum('lab_pending_count'),
    // Разрез по зданиям и сколько их. Плитка с одним числом на два дома обязана
    // сказать, из чего это число сложено; клиника в одном здании получает
    // список из одной строки, и экран его не показывает.
    buildings,
    building_count: buildings.length,
    lab_scope: labScope,
  };
}

// ---------------------------------------------------------------------------
// DASHBOARD_TREND_V1 (2026-09-11) — РЯДЫ ПО ДНЯМ И СТАЦИОНАР.
//
// Владелец: «create an appealing dashboard with graphs. add stationary
// patients too into an account».
//
// Сводка до этого знала только СЕГОДНЯ и только амбулаторию: шесть чисел без
// вчера, и ни одного слова о людях в койках. Здесь — то, из чего рисуются
// графики, и стационар как равный участник:
//   • деньги по дням, разложенные на амбулаторные и стационарные — по счёту,
//     к которому пришла оплата (invoices.admission_id, миграция 040). Это
//     единственный честный признак: платёж сам не знает, за что он;
//   • визиты, поступления и выписки по дням — движение людей;
//   • стационар СЕЙЧАС: кто в койке, сколько коек занято по отделениям,
//     сколько начислено и ещё не выставлено — деньги, которых касса пока не
//     видит, но которые уже заработаны.
//
// День — МЕСТНЫЙ (domain/day.js), тем же правилом, что и у кассы: иначе
// оплата в 23:30 уехала бы в завтрашний столбик графика.
// ---------------------------------------------------------------------------
const TREND_DAYS_DEFAULT = 14;
const TREND_DAYS_MAX = 90;

/** Календарные дни клиники, кончая сегодняшним, в порядке возрастания. */
function localDays(db, days) {
  const to = today(db);
  const end = new Date(to + 'T00:00:00Z').getTime();
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(end - i * 86400000).toISOString().slice(0, 10));
  return out;
}

export function dashboardTrend(db, args, _user) {
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const days = Math.max(1, Math.min(TREND_DAYS_MAX, Math.round(Number(args && args.days) || TREND_DAYS_DEFAULT)));
  const list = localDays(db, days);
  const from = list[0];
  const to = list[list.length - 1];
  const inBed = IN_BED_STATUSES.map((s) => `'${s}'`).join(',');

  const byDay = new Map(list.map((d) => [d, {
    date: d, clinic: 0, inpatient: 0, total: 0, visits: 0, admissions: 0, discharges: 0,
  }]));
  const bump = (d, key, v) => { const row = byDay.get(d); if (row) row[key] += Number(v) || 0; };

  // Деньги: приход кассы (без «кошелька» — это трата уже принятого депозита),
  // разложенный по счёту: у счёта госпитализации есть admission_id.
  for (const r of all(`
    SELECT ${localDate('p.paid_at')} AS d,
           CASE WHEN i.admission_id IS NOT NULL THEN 'inpatient' ELSE 'clinic' END AS kind,
           COALESCE(SUM(p.amount), 0) AS s
      FROM payments p
      JOIN invoices i ON i.id = p.invoice_id
     WHERE p.${INFLOW_SQL} AND ${inLocalRange('p.paid_at')}
     GROUP BY d, kind`, from, to)) {
    bump(r.d, r.kind, r.s);
    bump(r.d, 'total', r.s);
  }
  for (const r of all(`SELECT ${localDate('v.visit_date')} AS d, COUNT(*) AS n
      FROM visits v WHERE ${inLocalRange('v.visit_date')} GROUP BY d`, from, to)) bump(r.d, 'visits', r.n);
  for (const r of all(`SELECT ${localDate('a.admitted_at')} AS d, COUNT(*) AS n
      FROM admissions a WHERE a.status <> 'cancelled' AND ${inLocalRange('a.admitted_at')} GROUP BY d`, from, to)) bump(r.d, 'admissions', r.n);
  for (const r of all(`SELECT ${localDate('a.discharged_at')} AS d, COUNT(*) AS n
      FROM admissions a WHERE a.discharged_at IS NOT NULL AND ${inLocalRange('a.discharged_at')} GROUP BY d`, from, to)) bump(r.d, 'discharges', r.n);

  const series = list.map((d) => {
    const r = byDay.get(d);
    for (const k of ['clinic', 'inpatient', 'total']) r[k] = Math.round(r[k] * 100) / 100;
    return r;
  });
  const totals = series.reduce((t, r) => {
    for (const k of ['clinic', 'inpatient', 'total', 'visits', 'admissions', 'discharges']) t[k] = (t[k] || 0) + r[k];
    return t;
  }, {});
  for (const k of ['clinic', 'inpatient', 'total']) totals[k] = Math.round((totals[k] || 0) * 100) / 100;

  // Стационар сейчас. Занятость считается по ГОСПИТАЛИЗАЦИЯМ в койке, а не по
  // beds.status: статус койки уже расходился с реальностью (см. память о
  // дрейфе «occupied · no admission link»), а госпитализация — первоисточник.
  const in_bed = one(`SELECT COUNT(*) AS n FROM admissions WHERE status IN (${inBed})`).n;
  const beds_total = one('SELECT COUNT(*) AS n FROM beds').n;
  const beds_busy = one(`SELECT COUNT(DISTINCT bed_id) AS n FROM admissions
      WHERE bed_id IS NOT NULL AND status IN (${inBed})`).n;
  const wards = all(`
    SELECT w.id, w.name, COUNT(b.id) AS beds,
           COALESCE(SUM(CASE WHEN EXISTS (
             SELECT 1 FROM admissions a WHERE a.bed_id = b.id AND a.status IN (${inBed})
           ) THEN 1 ELSE 0 END), 0) AS busy
      FROM wards w
      LEFT JOIN beds b ON b.ward_id = w.id
     GROUP BY w.id
     ORDER BY w.name`);
  const accrued = one(`
    SELECT COALESCE(SUM(s.total), 0) AS s
      FROM admission_services s
      JOIN admissions a ON a.id = s.admission_id
     WHERE s.billable = 1 AND s.invoice_item_id IS NULL AND a.status IN (${inBed})`).s;
  const last = series[series.length - 1] || {};

  return {
    days, from, to, series, totals,
    inpatient: {
      in_bed,
      beds_total, beds_busy,
      occupancy: beds_total ? Math.round((beds_busy / beds_total) * 100) : 0,
      admitted_today: last.admissions || 0,
      discharged_today: last.discharges || 0,
      accrued_unbilled: Math.round(accrued * 100) / 100,
      wards: wards.map((w) => ({ id: w.id, name: w.name, beds: w.beds, busy: w.busy })),
    },
  };
}
