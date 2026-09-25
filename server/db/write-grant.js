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
//   • только прибавка к спискам ролей: регистратура, которая заводит источник
//     направления из карты пациента (referral_sources.insert), делает это
//     по-прежнему, даже если плитку «Список источников» ей закрыли, — закрытое
//     окно прячет экран настроек, а не работу регистратуры.
import { writeGrantKey, tableEntry } from './schema-registry.js';
import { grantAllowsOr } from '../services/grants.js';
import { catalogByKey } from '../../public/js/shared/permission-catalog.js';

const GRANTABLE_OPS = new Set(['insert', 'update']);
let byKey = null;

/** Разрешает ли право окна настроек эту операцию над таблицей. */
export function writeGrantAllows(table, op, user, db) {
  if (!db || !user || !GRANTABLE_OPS.has(op)) return false;
  const key = writeGrantKey(table);
  if (!key) return false;
  const entry = tableEntry(table);
  const w = entry && entry.write && entry.write[op];
  if (!w || typeof w !== 'object' || !Array.isArray(w.roles) || !w.roles.includes('admin')) return false;
  if (!byKey) byKey = catalogByKey();
  const row = byKey.get(key);
  if (!row || row.locked || !Array.isArray(row.levels) || !row.levels.includes('edit')) return false;
  try {
    // Прежнее правило — «нет»: ненастроенный ключ ничего не прибавляет, пишет
    // тот, кого пускает реестр.
    return grantAllowsOr(db, user, key, 'edit', () => false);
  } catch {
    return false;   // права не прочитались — самый узкий доступ
  }
}
