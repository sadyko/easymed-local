// ROLE_REPORTS_SETTINGS_V1 (2026-09-25) — КТО КАКИЕ ОТЧЁТЫ ВИДИТ: ОДИН ОТВЕТ.
//
// Владелец: «an option to read a report per section for roles». До этой правки
// отчёты не проверяли человека вовсе: шапка rpc/reports.js прямо говорила «any
// authenticated user may call these», а раздел «Отчёты» закрывал только пункт
// меню. Кассир, которому выдали «Отчёты» ради кассы, видел и зарплаты всех
// врачей — а тот, кому «Отчёты» не выдали, мог позвать run_report руками.
//
// ТЕПЕРЬ. Вид отчёта принадлежит группе (REPORT_GROUP в справочнике прав,
// public/js/shared/permission-catalog.js — та же карта, по которой хаб прячет
// плитки), а группа — окно раздела «Отчёты» в «Настройки → Роли». Ворота —
// grantAllowsOr, то есть все поправки справочника разом: администратор
// проходит, закрытый раздел «Отчёты» закрывает все группы, настроенная группа
// решает сама.
//
// ПРАВИЛО ПЕРЕХОДА. Группа, которую роль не настраивала, живёт по ПРЕЖНЕМУ
// правилу — тому, по которому оболочка открывала хаб: администратор или
// выданный раздел «Отчёты» (`reports-hub`). Никто после обновления не
// теряет ни одного отчёта; сужает только то, что заведующая сама поставила.
import { grantAllowsOr, isAdminUser, GrantError } from './grants.js';
import { canViewSection } from './roles.js';
import { REPORT_GROUP } from '../../public/js/shared/permission-catalog.js';

/** Прежнее правило: кому оболочка открывала хаб отчётов. */
export function reportsLegacyAllowed(db, user) {
  return isAdminUser(user) || canViewSection(db, user, 'reports-hub');
}

/** Видит ли человек группу отчётов (ключ окна раздела «Отчёты» или сам раздел). */
export function canSeeReportKey(db, user, key) {
  if (!user || !key) return false;
  return grantAllowsOr(db, user, key, 'view', () => reportsLegacyAllowed(db, user));
}

/** Группа вида отчёта — или null, если вид в карте не записан. */
export function reportGroupOf(kind) {
  return Object.prototype.hasOwnProperty.call(REPORT_GROUP, kind) ? REPORT_GROUP[kind] : null;
}

/**
 * Ворота отчёта: бросает 403, если группа этого вида человеку не выдана.
 * Вид, которого в карте нет, пускается только администратору: отчёт, забытый
 * в карте, не должен молча открыться всем.
 */
export function requireReportKind(db, user, kind) {
  const key = reportGroupOf(kind);
  const ok = key ? canSeeReportKey(db, user, key) : isAdminUser(user);
  if (ok) return;
  throw new GrantError('Этот отчёт недоступен вашей роли. Права выдаёт администратор в «Настройки → Роли».');
}
