// Dashboard summary RPC — read-only, today's-activity numbers for the admin
// landing page. No SELECT SUM/aggregate exists over /api/db, so this handler
// computes everything server-side from raw rows. Any authenticated user may
// call it (requireAuth is applied by the route; no extra role gate needed —
// see server/routes/rpc.js).

import { isLocalToday } from '../domain/day.js';
import { outstandingWhere } from '../domain/money.js';
import { INFLOW_SQL } from '../../../public/js/shared/payment-methods.js';   // DEPOSIT_REVENUE_V1

export function dashboardSummary(db, _args, _user) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  // "Today" is the LOCAL clinic day, matching the till — see domain/day.js.
  const patients_today = one(`SELECT COUNT(*) n FROM patients WHERE ${isLocalToday('created_at')}`).n;
  const visits_today   = one(`SELECT COUNT(*) n FROM visits WHERE ${isLocalToday('visit_date')}`).n;
  // DEPOSIT_REVENUE_V1 — без «кошелька»: это трата уже принятого депозита, а не
  // новые деньги в кассе.
  const collected_today = one(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE ${INFLOW_SQL} AND ${isLocalToday('paid_at')}`).s;
  const out = one(`SELECT COUNT(*) n, COALESCE(SUM(total_amount - paid_amount),0) s FROM invoices WHERE ${outstandingWhere()}`);
  const low_stock_count = one("SELECT COUNT(*) n FROM products WHERE active=1 AND reorder_level>0 AND on_hand<=reorder_level").n;
  // BRANCH_ORIGIN_V1 (mig 083) — плитка обязана считать ТО ЖЕ, что показывает
  // лабораторная очередь под ней, а очередь фильтрует «своё здание»
  // (sync_origin IS NULL, решение владельца 2026-09-02: «очередь и кабинет
  // врача — своего здания»). Без этого условия число на плитке росло бы от
  // работы соседнего филиала, которой в очереди нет, и лаборант искал бы
  // пробирки, которых у него никогда не было.
  const lab_pending_count = one(`SELECT COUNT(*) n FROM visit_services vs
      JOIN services s ON s.id = vs.service_id
      WHERE s.is_lab=1 AND vs.status IN ('queued','in_progress')
        AND vs.sync_origin IS NULL
        AND NOT EXISTS (SELECT 1 FROM lab_results lr WHERE lr.visit_service_id=vs.id AND lr.verified_at IS NOT NULL)`).n;

  return {
    patients_today, visits_today,
    collected_today: Math.round(collected_today * 100) / 100,
    outstanding_count: out.n,
    outstanding_amount: Math.round(out.s * 100) / 100,
    low_stock_count, lab_pending_count,
  };
}
