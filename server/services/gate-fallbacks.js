// ADMIN_ROWS_GRANTABLE_V1 (ревью безопасности, I3/C1) — ЧТО ДАЮТ НАСТОЯЩИЕ
// ВОРОТА, ПОКА КЛЮЧ НЕ НАСТРОЕН.
//
// Защита «Ролей» и «Сотрудников» сравнивает «что выдаёшь» с «что держишь сам».
// «Держишь» нельзя брать с экрана: экран выводит права из старых галочек
// (grantsFromLegacy раскладывает раздел на все его окна), а ворота сервера для
// ненастроенного ключа пускают по СВОЕМУ списку ролей в коде. Регистратура с
// галочкой «Койки» видит на экране «Измерения: Изменение», а ворота измерений
// (VITALS_WRITE_ROLES) её не пускают — и выдать другому это право она не должна.
//
// Здесь — те же списки, что у ворот, по ключу и уровню. Несколько ворот одного
// уровня — несколько списков. Тест (gate-fallbacks.test.js) сверяет эту карту с
// вызовами requireGrant / grantAllows в services/rpc — копия не разойдётся с
// оригиналом молча.
import { hasAnyRole, canViewSection, canEditSection } from './roles.js';
import { catalogByKey } from '../../public/js/shared/permission-catalog.js';

export const GATE_FALLBACK = Object.freeze({
  'inpatient.services':      { view: [['admin', 'head_doctor', 'registrar', 'nurse', 'doctor', 'cashier']],
                               edit: [['admin', 'head_doctor', 'doctor'], ['admin', 'head_doctor', 'doctor', 'nurse', 'senior_nurse']] },
  'inpatient.history':       { view: [['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse', 'registrar', 'cashier']] },
  'inpatient.patients':      { view: [['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse']] },
  'inpatient.reviews':       { view: [['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse']], edit: [['doctor', 'head_doctor', 'admin']] },
  'inpatient.discharge':     { edit: [['admin', 'nurse', 'senior_nurse', 'head_doctor']] },
  'inpatient.beds':          { edit: [['admin', 'registrar', 'nurse', 'senior_nurse', 'head_doctor']] },
  'inpatient.requests':      { edit: [['registrar', 'senior_nurse', 'doctor', 'head_doctor', 'admin']] },
  'inpatient.prescriptions': { view: [['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse']],
                               edit: [['doctor', 'head_doctor', 'admin']], delete: [['doctor', 'head_doctor', 'admin']] },
  'inpatient.marks':         { view: [['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse']],
                               edit: [['nurse', 'senior_nurse', 'admin'], ['nurse', 'senior_nurse', 'admin']] },
  'inpatient.vitals':        { view: [['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse']],
                               edit: [['nurse', 'senior_nurse', 'doctor', 'head_doctor', 'admin']], delete: [['admin']] },
  'procurement.issue':       { edit: [['admin', 'inventory'], ['admin', 'inventory']] },
  'crm.dial':                { edit: [['admin', 'registrar', 'callcenter']] },
  'crm.calls':               { view: [['admin', 'registrar', 'callcenter']] },
  'crm.recording':           { edit: [['admin', 'registrar', 'callcenter'], ['admin', 'registrar', 'callcenter']] },
  // row-scope: crm_requests.scope.allRoles
  'crm.all':                 { edit: [['admin']] },
  // Не ворота RPC, а реестр: вставку в patients делают эти роли.
  'crm.convert':             { edit: [['admin', 'registrar', 'callcenter']] },
});

// Ворота, чьё «как было» — не список ролей, а прежняя галочка раздела.
const FALLBACK_FN = {
  'custdev.list': { view: (db, u) => canViewSection(db, u, 'custdev') },
  'custdev.rate': { edit: (db, u) => canEditSection(db, u, 'custdev') },
  'settings.departments': {
    view: (db, u) => hasAnyRole(u, ['admin', 'inventory']) || canViewSection(db, u, 'settings'),
    edit: (db, u) => hasAnyRole(u, ['admin']) || canEditSection(db, u, 'settings'),
  },
  procurement: {
    view: (db, u) => hasAnyRole(u, ['admin', 'inventory']) || canViewSection(db, u, 'inventory'),
    edit: (db, u) => hasAnyRole(u, ['admin', 'inventory']),
  },
};

const ORDER = ['delete', 'edit', 'view'];
let byKey = null;

/**
 * Уровень, который ворота ключа дают человеку, пока ключ не настроен:
 * 'none' | 'view' | 'edit' | 'delete' — или null, если у ключа НЕТ серверных
 * ворот (раздел, маршрут оболочки): тогда решает вывод экрана.
 *
 * mode 'all' — для того, КТО ВЫДАЁТ: уровень засчитан, только если его пускают
 * ВСЕ ворота этого уровня (строже). mode 'any' — для того, КОМУ ВЫДАЮТ:
 * достаточно одних ворот (тоже строже — в свою сторону).
 */
export function fallbackLevel(db, user, key, mode = 'all') {
  if (!byKey) byKey = catalogByKey();
  const lists = GATE_FALLBACK[key];
  if (lists) {
    for (const need of ORDER) {
      const ls = lists[need];
      if (!ls) continue;
      const ok = mode === 'all' ? ls.every((l) => hasAnyRole(user, l)) : ls.some((l) => hasAnyRole(user, l));
      if (ok) return need;
    }
    return 'none';
  }
  const fns = FALLBACK_FN[key];
  if (fns) {
    for (const need of ORDER) if (fns[need] && fns[need](db, user)) return need;
    return 'none';
  }
  const row = byKey.get(key);
  if (!row) return 'none';
  if (row.adminDefault) return hasAnyRole(user, ['admin']) ? (row.levels[row.levels.length - 1] || 'none') : 'none';
  if (row.parent === 'reports') return (hasAnyRole(user, ['admin']) || canViewSection(db, user, 'reports-hub')) ? 'view' : 'none';
  // Плитки настроек: читать их таблицы сервер не запрещает, пишет по праву — «нет».
  if (row.parent === 'settings') return 'view';
  // Раздел или маршрут оболочки — серверных ворот у ключа нет.
  return null;
}
