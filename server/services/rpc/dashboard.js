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

import { isLocalToday } from '../domain/day.js';
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
