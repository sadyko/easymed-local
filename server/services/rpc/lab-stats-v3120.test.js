// V3120_PERF — lab_usage_stats: период через индекс по created_at
// (day.js localRangeWhere) и панели, которые ведут заказы, а не наоборот.
// Цифры обязаны остаться ТЕМИ ЖЕ: прежние запросы воспроизведены здесь
// дословно (reference) и сравниваются с новыми на всех четырёх периодах —
// заказы у самой местной полуночи, в трёх формах записи времени, неактивная
// панель и одноимённые панели, все четыре ветви «что такое лабораторная услуга», чужое
// здание, lab_scope=building.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { labUsageStats } from './lab-stats.js';
import { inLocalRange, today } from '../domain/day.js';
import { LAB_NAME_RE } from '../../../public/js/admin/views/lab-service.js';
import {
  buildingContext, originExpr, summariseByBuilding, labScopeOf, labScopeWhere,
} from '../domain/buildings.js';

const LAB = { id: 2, role: 'lab' };
const PERIODS = { today: 0, '7d': 6, '30d': 29, all: null };
const PMAP_CTE = `pmap AS (
  SELECT service_id, MIN(id) AS panel_id FROM lab_panels
   WHERE active = 1 AND service_id IS NOT NULL GROUP BY service_id)`;

// ── прежняя реализация (до V3120_PERF) ───────────────────────────────────────
function reference(db, period) {
  const days = PERIODS[period];
  const to = today(db);
  const from = days == null ? null : db.prepare("SELECT date('now','localtime', ?) d").get('-' + days + ' days').d;
  const range = from == null ? '1=1' : inLocalRange('vs.created_at');
  const rangeParams = from == null ? [] : [from, to];
  const ctx = buildingContext(db);
  const labScope = labScopeOf(db);
  const scopeSql = labScopeWhere(db, labScope, 'visit_services', 'vs');
  const vsOrigin = originExpr(db, 'visit_services', 'vs');
  const labTypeIds = db.prepare('SELECT id, name FROM service_types').all()
    .filter((t) => LAB_NAME_RE.test(t.name || '')).map((t) => Number(t.id)).filter(Number.isInteger);
  const typeClause = labTypeIds.length ? `OR s.type_id IN (${labTypeIds.map(() => '?').join(',')})` : '';
  const panels = db.prepare(`
    WITH ${PMAP_CTE}
    SELECT lp.id AS panel_id, lp.name AS name, lp.code AS code, lp.service_id AS service_id, s.name AS service_name,
           COUNT(vs.id) AS ordered, SUM(CASE WHEN vs.status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM pmap
      JOIN lab_panels lp ON lp.id = pmap.panel_id
      JOIN visit_services vs ON vs.service_id = pmap.service_id
      LEFT JOIN services s ON s.id = pmap.service_id
     WHERE ${range}${scopeSql}
     GROUP BY lp.id ORDER BY ordered DESC, lp.name`).all(...rangeParams);
  const services = db.prepare(`
    WITH ${PMAP_CTE}
    SELECT s.id AS service_id, s.name AS name, COUNT(vs.id) AS ordered,
           SUM(CASE WHEN vs.status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM visit_services vs JOIN services s ON s.id = vs.service_id
     WHERE ${range}${scopeSql}
       AND s.id NOT IN (SELECT service_id FROM pmap)
       AND (s.type = 'lab' OR s.is_lab = 1
            OR s.department_id IN (SELECT id FROM departments WHERE kind = 'laboratory') ${typeClause})
     GROUP BY s.id ORDER BY ordered DESC, s.name`).all(...rangeParams, ...labTypeIds);
  const perBuilding = db.prepare(`
    WITH ${PMAP_CTE}
    SELECT ${vsOrigin} AS origin, COUNT(vs.id) AS ordered,
           SUM(CASE WHEN vs.status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM visit_services vs JOIN services s ON s.id = vs.service_id
     WHERE ${range}${scopeSql}
       AND (s.id IN (SELECT service_id FROM pmap) OR s.type = 'lab' OR s.is_lab = 1
            OR s.department_id IN (SELECT id FROM departments WHERE kind = 'laboratory') ${typeClause})
     GROUP BY origin`).all(...rangeParams, ...labTypeIds);
  const buildings = summariseByBuilding(ctx, perBuilding, {
    ordered: (r) => r.ordered || 0, completed: (r) => r.completed || 0,
  }).map((b) => { const { rows: _rows, ...rest } = b; return rest; });
  return { period, from, to, panels, services, buildings, lab_scope: labScope };
}

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO branches (name, letter, active) VALUES ('Чиланзар','B',0)").run();
  const labDept = db.prepare("INSERT INTO departments (name, kind) VALUES ('Лаборатория','laboratory')").run().lastInsertRowid;
  const labType = db.prepare("INSERT INTO service_types (name) VALUES ('Лабораторные исследования')").run().lastInsertRowid;
  const S = (name, extra = {}) => db.prepare(
    'INSERT INTO services (name, price, type, is_lab, department_id, type_id) VALUES (?,0,?,?,?,?)')
    .run(name, extra.type || 'other', extra.is_lab || 0, extra.dept || null, extra.type_id || null).lastInsertRowid;
  const svc = [
    S('ОАК', { type: 'lab' }), S('Б/х', { type: 'lab' }), S('Д-димер', { is_lab: 1 }),
    S('Ферритин', { dept: labDept }), S('ПЦР', { type_id: labType }), S('Приём', { type: 'consultation' }),
    S('Коагулограмма', { type: 'lab' }), S('ТТГ', { type: 'lab' }),
  ];
  const P = (name, sid, active = 1) => db.prepare('INSERT INTO lab_panels (name, code, service_id, active) VALUES (?,?,?,?)').run(name, name.slice(0, 3), sid, active);
  P('Общий анализ крови', svc[0]);
  P('Биохимия', svc[1]);                                   // (одна услуга — одна панель: UNIQUE)
  P('Коагулограмма', svc[6], 0);                          // неактивная — услуга уходит в «услуги»
  P('Гормоны', svc[7]); P('Гормоны', svc[5]);               // одинаковое имя у двух панелей

  const off = db.prepare("SELECT CAST(strftime('%s','now','localtime') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) s").get().s;
  const td = today(db);
  const dayOf = (k) => db.prepare('SELECT date(?, ?) d').get(td, k + ' days').d;
  const midnight = (d) => Date.parse(d + 'T00:00:00Z') - off * 1000;
  let rnd = 11;
  const rand = (n) => { rnd = (rnd + 0x6D2B79F5) | 0; let t = Math.imul(rnd ^ (rnd >>> 15), 1 | rnd); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (1, '2026-01-01T09:00:00Z')").run().lastInsertRowid;
  const ins = db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_at, sync_origin) VALUES (?,?,1,0,0,?,?,?)');
  const edges = [0, 1, -1, 500, -500, 60e3, -60e3, 12 * 3600e3];
  const statuses = ['added', 'queued', 'in_progress', 'resulted', 'completed', 'completed'];
  for (let k = -45; k <= 1; k++) {
    for (let j = 0; j < 12; j++) {
      const iso = new Date(midnight(dayOf(k)) + edges[rand(edges.length)]).toISOString();
      const f = rand(3);
      const at = f === 0 ? iso.slice(0, 19) + 'Z' : f === 1 ? iso : iso.slice(0, 10) + ' ' + iso.slice(11, 19);
      ins.run(v, svc[rand(svc.length)], statuses[rand(statuses.length)], at, rand(4) === 0 ? 'B' : null);
    }
  }
  return db;
}

test('lab_usage_stats: те же цифры, что прежние запросы, на всех периодах', () => {
  const db = seed();
  for (const period of Object.keys(PERIODS)) {
    const want = reference(db, period);
    assert.ok(want.panels.length > 0 && want.services.length > 0, 'фикстура обязана наполнять оба блока: ' + period);
    assert.deepEqual(labUsageStats(db, { period }, LAB), want, period);
  }
  db.prepare("UPDATE doc_settings SET lab_scope = 'building' WHERE id = 1").run();
  for (const period of Object.keys(PERIODS)) {
    assert.deepEqual(labUsageStats(db, { period }, LAB), reference(db, period), 'building ' + period);
  }
  db.close();
});

test('lab_usage_stats: ограниченный период идёт по индексу created_at', () => {
  const db = seed();
  const plans = [];
  const orig = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/visit_services vs/.test(sql) && /created_at/.test(sql)) plans.push(sql);
    return orig(sql);
  };
  labUsageStats(db, { period: '7d' }, LAB);
  db.prepare = orig;
  assert.equal(plans.length, 3);
  for (const sql of plans) {
    const n = (sql.match(/\?/g) || []).length;
    const detail = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...Array(n).fill('2026-09-01'))
      .map((r) => r.detail).join(' | ');
    assert.match(detail, /visit_services_created/, detail);
  }
  db.close();
});
