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
import { grantAllowsOr, isAdminUser, GrantError, roleGrantsOf, ownCustomGrants } from './grants.js';   // ownCustomGrants: JOURNALS_V1_RJ3
import { canViewSection } from './roles.js';
import { REPORT_GROUP, isAdminDefault, levelAllows } from '../../public/js/shared/permission-catalog.js';   // levelAllows: JOURNALS_V1_RJ2 (F3)

/** Прежнее правило: кому оболочка открывала хаб отчётов. */
export function reportsLegacyAllowed(db, user) {
  return isAdminUser(user) || canViewSection(db, user, 'reports-hub');
}

// JOURNALS_V1_RJ3 (2026-10-02) — «ЖУРНАЛЫ»: ДОСТУП ТОЛЬКО ЯВНЫЙ.
//
// Журналы несут диагнозы, заключения, паспорта, телефоны и оплаты. Прежнее
// правило групп («настройки нет — видит тот, у кого раздел „Отчёты“») и
// эвристика RJ2 («роль с настроенными группами — „Нет“») давали дыру на каждом
// краю: копии кассира и склада, сделанные до миграции 179, справочник главной
// клиники старой версии на филиале, сохранение другой группы, переворачивающее
// ответ. Поэтому у ОДНОГО ключа «Журналы» прежнего правила нет:
//   • роль, которой в «Ролях» ЯВНО выдано «Журналы: Просмотр», — видит. Роль,
//     которая сама закрыла раздел «Отчёты», своих журналов не открывает
//     (закрытый раздел закрывает то, что в нём: уровни окон после «Отчёты: Нет»
//     остаются в матрице). Раздел у ДРУГИХ ролей человека не мешает: главный
//     врач — врач с надстройкой «Главный врач», и «Отчёты: Нет» у врачей не
//     запирает выданное надстройке;
//   • администратор (ролью или дополнительной ролью) — видит, пока СВОЯ роль
//     клиники на основе администратора их не закрыла — ключом «Журналы» или
//     разделом «Отчёты» («своё „Нет“», как у прочих групп). «Нет» его
//     дополнительных ролей ему не закрывает, их явная выдача — прибавка;
//   • все остальные — «Нет», настроена роль или нет, есть ли у неё «Отчёты».
// Прочие группы — без изменений. То же правило — оболочка (permissions.js
// reportGroupAllowed) и стандарт экрана «Роли» (gate-fallbacks.js fallbackLevel).
export const JOURNALS_KEY = 'reports.journals';

/** Роль человека сама выдала «Журналы» (не ниже «Просмотр») и сама «Отчёты» не закрыла. */
export function journalsGrantedByRole(db, user) {
  return roleGrantsOf(db, user).some((g) => levelAllows(g[JOURNALS_KEY], 'view') && g.reports !== 'none');
}

/** «Журналы» — явный доступ (JOURNALS_V1_RJ3). */
export function canSeeJournals(db, user) {
  if (!user) return false;
  if (journalsGrantedByRole(db, user)) return true;
  if (!isAdminUser(user)) return false;
  const own = ownCustomGrants(db, user);
  if (!own) return true;
  if (own.reports === 'none') return false;
  return !Object.prototype.hasOwnProperty.call(own, JOURNALS_KEY) || levelAllows(own[JOURNALS_KEY], 'view');
}

/** Видит ли человек группу отчётов (ключ окна раздела «Отчёты» или сам раздел). */
export function canSeeReportKey(db, user, key) {
  if (!user || !key) return false;
  if (key === JOURNALS_KEY) return canSeeJournals(db, user);   // JOURNALS_V1_RJ3 — явный доступ
  // ADMIN_ROWS_GRANTABLE_V1 — группа с правилом «только администратор»
  // (охват Telegram-бота) у ненастроенной роли открыта одному администратору,
  // а не всем, кому выданы «Отчёты».
  const legacy = isAdminDefault(key) ? () => isAdminUser(user) : () => reportsLegacyAllowed(db, user);
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
