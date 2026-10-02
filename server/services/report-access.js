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
import { grantAllowsOr, isAdminUser, GrantError, roleGrantsOf } from './grants.js';
import { canViewSection } from './roles.js';
import { REPORT_GROUP, isAdminDefault } from '../../public/js/shared/permission-catalog.js';

/** Прежнее правило: кому оболочка открывала хаб отчётов. */
export function reportsLegacyAllowed(db, user) {
  return isAdminUser(user) || canViewSection(db, user, 'reports-hub');
}

// JOURNALS_V1_RJ2 (финальное ревью, F1) — «ЖУРНАЛЫ: НЕТ» НЕ ДОЛЖНО ПРОПАДАТЬ.
//
// Миграция 235 записала «Нет» ролям с настроенными группами отчётов, но
// запись живёт, пока права роли не перепишут без этого ключа: справочник
// главной клиники старой версии затирает role_permissions филиала
// (branch-sync/catalogue.js), устаревшая вкладка «Роли» сохраняет матрицу без
// новой строки. Тогда роль падала в прежнее правило групп — и кассир, склад,
// колл-центр и их копии видели паспорта и диагнозы.
//
// Поэтому правило — в КОДЕ, для одного ключа «Журналы»: если хоть одна роль
// человека НАСТРОЕНА (есть ключ «reports.…» — признак миграций 179 и 235) и
// ни одна не записала «Журналы», ответ — «Нет». Прежнее правило — только когда
// ни у одной роли нет ни одного ключа «reports.…». Прочие группы — как были.
// Оболочка отвечает так же (permissions.js reportGroupAllowed), экран «Роли» —
// тоже (gate-fallbacks.js fallbackLevel): иначе он нарисовал бы «Просмотр» и
// записал его при следующем сохранении.
export const JOURNALS_KEY = 'reports.journals';
export function reportsConfigured(db, user) {
  return roleGrantsOf(db, user).some((g) => Object.keys(g).some((k) => k.startsWith('reports.')));
}

/** Видит ли человек группу отчётов (ключ окна раздела «Отчёты» или сам раздел). */
export function canSeeReportKey(db, user, key) {
  if (!user || !key) return false;
  // ADMIN_ROWS_GRANTABLE_V1 — группа с правилом «только администратор»
  // (охват Telegram-бота) у ненастроенной роли открыта одному администратору,
  // а не всем, кому выданы «Отчёты».
  const legacy = isAdminDefault(key) ? () => isAdminUser(user)
    : key === JOURNALS_KEY ? () => !reportsConfigured(db, user) && reportsLegacyAllowed(db, user)   // JOURNALS_V1_RJ2 (F1)
      : () => reportsLegacyAllowed(db, user);
  return grantAllowsOr(db, user, key, 'view', legacy);
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
