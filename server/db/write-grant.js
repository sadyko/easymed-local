// ROLE_REPORTS_SETTINGS_V1 (2026-09-25) — ЗАПИСЬ В ТАБЛИЦУ НАСТРОЕК ПО ПРАВУ ИЗ «РОЛЕЙ».
//
// Владелец: «in the settings per section and per subsection for the roles»;
// решение: «Изменение» даёт НАСТОЯЩЕЕ право сохранять — сервер проверяет тот
// же ключ, что рисует экран «Роли».
//
// Таблицы справочников настроек (категории пациентов, плательщики, источники
// направлений, помещения…) до сих пор писал только администратор: так записано
// в реестре (schema-registry.js), и реестр — статическая таблица ролей. Право
// окна — свойство РОЛИ КЛИНИКИ и живёт в базе (role_permissions.grants),
// поэтому, как и `scope.allGrant` (row-scope.js), читается здесь, где база под
// рукой, а реестр только называет ключ (`write.grant`).
//
// ЧТО КЛЮЧ ОТКРЫВАЕТ, А ЧТО НЕТ. Он встаёт ВМЕСТО администратора и не шире:
//   • только вставку и правку — удаление остаётся списку ролей (у окон настроек
//     уровня «Удаление» нет вовсе);
//   • только ту операцию, которую реестр даёт администратору: где запись не
//     разрешена никому (doc_settings.insert), ключ её не выдумывает;
//   • только ключ живой строки справочника с уровнем «Изменение», не закрытой
//     (`locked`): ключ, написанный в базу руками, сам по себе ничего не значит;
//   • только колонки без денег (`grantColumns` строки справочника, ревью I2):
//     цены, проценты, ставки и способы оплаты пишет только администратор, и
//     запись с такой колонкой отклоняется целиком (writeGrantViolation);
//   • только прибавка к спискам ролей: регистратура, которая заводит источник
//     направления из карты пациента (referral_sources.insert), делает это
//     по-прежнему, даже если плитку «Список источников» ей закрыли, — закрытое
//     окно прячет экран настроек, а не работу регистратуры.
//
// И ОДНО СУЖЕНИЕ (ревью I1): своя роль клиники на основе администратора, у
// которой плитка (или весь раздел «Настройки») закрыта ЕЁ СОБСТВЕННОЙ записью,
// писать в таблицы плитки не может, хотя реестр пускает основу `admin`, — то
// же правило «своё „Нет“», что у grantAllowsOr (writeGrantNarrows).
import { writeGrantKey, tableEntry, writableColumns } from './schema-registry.js';
import { grantAllowsOr, isAdminUser } from '../services/grants.js';
import { catalogByKey } from '../../public/js/shared/permission-catalog.js';

const GRANTABLE_OPS = new Set(['insert', 'update']);
let byKey = null;
const rowOf = (key) => { if (!byKey) byKey = catalogByKey(); return byKey.get(key) || null; };

/** Разрешает ли право окна настроек эту операцию над таблицей. */
export function writeGrantAllows(table, op, user, db) {
  if (!db || !user || !GRANTABLE_OPS.has(op)) return false;
  const key = writeGrantKey(table);
  if (!key) return false;
  const entry = tableEntry(table);
  const w = entry && entry.write && entry.write[op];
  if (!w || typeof w !== 'object' || !Array.isArray(w.roles) || !w.roles.includes('admin')) return false;
  const row = rowOf(key);
  if (!row || row.locked || !Array.isArray(row.levels) || !row.levels.includes('edit')) return false;
  try {
    // Прежнее правило — «нет»: ненастроенный ключ ничего не прибавляет, пишет
    // тот, кого пускает реестр.
    return grantAllowsOr(db, user, key, 'edit', () => false);
  } catch {
    return false;   // права не прочитались — самый узкий доступ
  }
}

/**
 * Колонки таблицы, которые вправе писать право окна (а не администратор), —
 * или null, если у плитки для этой таблицы ограничений нет.
 */
export function grantColumnsFor(table) {
  const key = writeGrantKey(table);
  const row = key ? rowOf(key) : null;
  const cols = row && row.grantColumns && row.grantColumns[table];
  return Array.isArray(cols) ? cols : null;
}

/**
 * Первая колонка записи, которую право окна писать НЕ вправе (цена, процент,
 * ставка…), — или null. Колонки вне реестра не в счёт: компилятор их и так
 * отбрасывает.
 */
export function writeGrantViolation(table, op, values) {
  const allowed = grantColumnsFor(table);
  if (!allowed) return null;
  const writable = new Set(writableColumns(table, op === 'upsert' ? 'insert' : op));
  const rows = Array.isArray(values) ? values : [values || {}];
  for (const row of rows) {
    for (const k of Object.keys(row || {})) {
      if (writable.has(k) && !allowed.includes(k)) return k;
    }
  }
  return null;
}

/**
 * Ревью I1 — администратор, которому таблицу плитки закрыла ЕГО СОБСТВЕННАЯ
 * роль клиники (своя роль на основе `admin` с «Нет»/«Просмотром» у плитки или
 * «Нет» у раздела). Штатный администратор и администратор-врач сюда не
 * попадают: у них своей матрицы нет, и grantAllowsOr пускает их сразу.
 */
export function writeGrantNarrows(table, user, db) {
  if (!db || !user || !isAdminUser(user)) return false;
  const key = writeGrantKey(table);
  if (!key) return false;
  try {
    return !grantAllowsOr(db, user, key, 'edit', () => true);
  } catch {
    return false;
  }
}
