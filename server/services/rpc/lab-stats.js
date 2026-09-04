// LAB_STATS_V1 — «Лаборатория → Статистика»: how many times each panel and
// each bare lab service was ordered in a period, and how many of those orders
// were completed. COUNTS ONLY — deliberately no money anywhere in the
// response: revenue lives in «Отчёты» behind its own permissions, while this
// screen is visible to every lab-section role, лаборант included.
//
// Access: the SAME constant the panel-catalog writes key on
// (schema-registry.js LAB_SECTION_ROLES = admin/doctor/lab/nurse — the seeded
// labs-section roles). The stats read and the panel writes are two doors of
// one section and must never disagree.
//
// The double-count rule (a PARTITION, decided from the schema):
//   * lab_panels.service_id links a panel to the billable service the clinic
//     sells it as — ordering that service IS ordering the panel. So a
//     visit_services row whose service carries an ACTIVE panel is counted in
//     the «Панели» block, attributed to that panel;
//   * the «Лабораторные услуги» block gets lab-type services WITHOUT an
//     active panel (Д-димер sold as a single price line, etc.);
//   * therefore every order lands in EXACTLY ONE block — a service that IS a
//     panel's service is never repeated in the services block.
//   Edge cases, same source of truth as the queue (views/laboratory.js loads
//   only active=1 panels into panelByService): an inactive panel does not
//   claim its service (orders fall to the services block if the service is
//   lab work by its own attributes); should two active panels ever share one
//   service, MIN(panel id) claims it, so the orders are still counted once.
//
// «Выполнено» = status='completed' — the terminal state of migration 041's
// lab lifecycle (added → queued → collected → in_progress → resulted →
// completed), stamped by «Проверить и выдать». 'resulted' is NOT completed:
// results are entered but unverified, the patient has nothing in hand yet.
// «Заказано» counts every lifecycle status including 'added' (invoice raised,
// awaiting payment): the order was placed — that is what usage means.
//
// What is a LAB service is the same four-branch rule as the client's
// lab-service.js (LAB_SERVICE_ROUTING_V1): type='lab' / is_lab, a laboratory
// DEPARTMENT, a laboratory-named catalogue TYPE, or a linked active panel.
// The type-NAME branch runs its regex in JS (imported from the shared module,
// so the two rules cannot drift): SQLite lower() does not fold Cyrillic, and
// «Лаборатория» would never match a LIKE.

import { hasAnyRole } from '../roles.js';
import { LAB_SECTION_ROLES } from '../../db/schema-registry.js';
import { inLocalRange, today } from '../domain/day.js';
// Pure browser-shared module (no DOM) — same cross-import precedent as
// reports.js taking formatMethods from public/js/shared/payment-methods.js.
import { LAB_NAME_RE } from '../../../public/js/admin/views/lab-service.js';
// LAB_ONE_CLINIC_V1 / BUILDING_REPORTS_V1 — граница «чьи это заказы».
//
// У этого экрана фильтра не было ВООБЩЕ: он считал заказы всей клиники по
// случайности, а не по решению, и настройку doc_settings.lab_scope (миграция
// 085) не знал. Клиника с двумя настоящими лабораториями, переключившая очередь
// на «только своё здание», видела здесь по-прежнему обе — статистика говорила
// одно, очередь под ней другое. Правило берётся из общего с экраном модуля.
import {
  buildingContext, originExpr, summariseByBuilding, labScopeOf, labScopeWhere,
} from '../domain/buildings.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// The four periods the screen's chips offer. Value = how many days back the
// window starts (inclusive, so '30d' spans 30 local calendar days including
// today); null = no lower bound.
const PERIODS = { today: 0, '7d': 6, '30d': 29, all: null };

// One active panel per service (MIN id wins duplicates — see header).
const PMAP_CTE = `pmap AS (
  SELECT service_id, MIN(id) AS panel_id
    FROM lab_panels
   WHERE active = 1 AND service_id IS NOT NULL
   GROUP BY service_id
)`;

export function labUsageStats(db, args, user) {
  if (!hasAnyRole(user, LAB_SECTION_ROLES)) {
    throw new RpcError('Статистику лаборатории видят роли с разделом «Лаборатория».', 403);
  }

  const raw = args && args.period != null && args.period !== '' ? args.period : '30d';
  if (typeof raw !== 'string' || !Object.prototype.hasOwnProperty.call(PERIODS, raw)) {
    throw new RpcError('period must be one of: today, 7d, 30d, all.', 400);
  }
  const period = raw;
  const days = PERIODS[period];
  const to = today(db);
  const from = days == null
    ? null
    : db.prepare("SELECT date('now','localtime', ?) d").get('-' + days + ' days').d;

  // Period filter on the ORDER date (visit_services.created_at, local day —
  // CLINIC_DAY_V1). from/to are bound only when the window is bounded.
  const range = from == null ? '1=1' : inLocalRange('vs.created_at');
  const rangeParams = from == null ? [] : [from, to];

  // Граница лаборатории — та же, что у очереди: настройка клиники, а не
  // константа и не «как получилось».
  const ctx = buildingContext(db);
  const labScope = labScopeOf(db);
  const scopeSql = labScopeWhere(db, labScope, 'visit_services', 'vs');
  const vsOrigin = originExpr(db, 'visit_services', 'vs');

  // The catalogue-TYPE branch of the lab rule: ids of service_types whose name
  // reads like a laboratory. Computed in JS (Cyrillic case-folding), fed to
  // SQL as a validated integer list.
  const labTypeIds = db.prepare('SELECT id, name FROM service_types').all()
    .filter((t) => LAB_NAME_RE.test(t.name || ''))
    .map((t) => Number(t.id))
    .filter(Number.isInteger);
  const typeClause = labTypeIds.length
    ? `OR s.type_id IN (${labTypeIds.map(() => '?').join(',')})`
    : '';

  // Блок «Панели»: заказы услуг, к которым привязана активная панель.
  const panels = db.prepare(`
    WITH ${PMAP_CTE}
    SELECT lp.id            AS panel_id,
           lp.name          AS name,
           lp.code          AS code,
           lp.service_id    AS service_id,
           s.name           AS service_name,
           COUNT(vs.id)     AS ordered,
           SUM(CASE WHEN vs.status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM pmap
      JOIN lab_panels lp ON lp.id = pmap.panel_id
      JOIN visit_services vs ON vs.service_id = pmap.service_id
      LEFT JOIN services s ON s.id = pmap.service_id
     WHERE ${range}${scopeSql}
     GROUP BY lp.id
     ORDER BY ordered DESC, lp.name
  `).all(...rangeParams);

  // Блок «Лабораторные услуги»: лабораторные услуги БЕЗ активной панели.
  const services = db.prepare(`
    WITH ${PMAP_CTE}
    SELECT s.id         AS service_id,
           s.name       AS name,
           COUNT(vs.id) AS ordered,
           SUM(CASE WHEN vs.status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM visit_services vs
      JOIN services s ON s.id = vs.service_id
     WHERE ${range}${scopeSql}
       AND s.id NOT IN (SELECT service_id FROM pmap)
       AND (s.type = 'lab' OR s.is_lab = 1
            OR s.department_id IN (SELECT id FROM departments WHERE kind = 'laboratory')
            ${typeClause})
     GROUP BY s.id
     ORDER BY ordered DESC, s.name
  `).all(...rangeParams, ...labTypeIds);

  // BUILDING_REPORTS_V1 — сколько заказов дало каждое ЗДАНИЕ. Считается по тем
  // же строкам и той же границе, что блоки выше: иначе разрез спорил бы с
  // таблицами над ним.
  const perBuilding = db.prepare(`
    WITH ${PMAP_CTE}
    SELECT ${vsOrigin} AS origin,
           COUNT(vs.id) AS ordered,
           SUM(CASE WHEN vs.status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM visit_services vs
      JOIN services s ON s.id = vs.service_id
     WHERE ${range}${scopeSql}
       AND (s.id IN (SELECT service_id FROM pmap)
            OR s.type = 'lab' OR s.is_lab = 1
            OR s.department_id IN (SELECT id FROM departments WHERE kind = 'laboratory')
            ${typeClause})
     GROUP BY origin
  `).all(...rangeParams, ...labTypeIds);
  const buildings = summariseByBuilding(ctx, perBuilding, {
    ordered:   (r) => r.ordered || 0,
    completed: (r) => r.completed || 0,
  }).map((b) => { const { rows: _rows, ...rest } = b; return rest; });

  // Zero-use rows never appear: both blocks are built FROM the orders, so a
  // panel or service nobody ordered in the period has no row to group.
  return { period, from, to, panels, services, buildings, lab_scope: labScope };
}
