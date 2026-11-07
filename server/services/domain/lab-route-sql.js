// DIAG_ROUTE_V1 (3.22.0, ревью L-5) — «ЭТО АНАЛИЗ» ДЛЯ SQL СЕРВЕРА: ТО ЖЕ ПРАВИЛО, ЧТО У ОЧЕРЕДИ
// ЛАБОРАТОРИИ (shared/service-route.js serviceRoute === 'lab').
//
// Группа «Лаборатория» или её зеркало is_lab (миграция 048); отделение видом «Лаборатория» и
// «лабораторное» имя типа каталога (LAB_NAME_RE) — только у услуги без группы и группы
// «Консультации» (hintedSql — умолчание колонки, под которым клиники держат анализы). То же
// выражение уже стоит в lab-stats.js (LAB_SVC_SQL); здесь — для счётчиков сводки
// (dashboard.js, dashboard-overview.js), которые узнавали анализ по одному is_lab.
//
// Имена типов сравниваются в JS (кириллица без учёта регистра), в SQL уходят номерами —
// связанными параметрами.
import { hintedSql, LAB_NAME_RE } from '../../../public/js/shared/service-route.js';

/** → { sql, params }: условие «услуга s — анализ» (s — псевдоним services). */
export function labRouteSql(db, s = 's') {
  const ids = db.prepare('SELECT id, name FROM service_types').all()
    .filter((t) => LAB_NAME_RE.test(t.name || ''))
    .map((t) => Number(t.id))
    .filter(Number.isInteger);
  const typeClause = ids.length ? ` OR ${s}.type_id IN (${ids.map(() => '?').join(',')})` : '';
  return {
    sql: `(${s}.type = 'lab' OR ${s}.is_lab = 1 OR (${hintedSql(s)} AND (${s}.department_id IN (SELECT id FROM departments WHERE kind = 'laboratory')${typeClause})))`,
    params: ids,
  };
}
