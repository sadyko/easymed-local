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
//     уровня «Удаление» нет вовсе; ADMIN_ROWS_GRANTABLE_V1 — кроме строк, у
//     которых «Удаление» есть, см. ниже);
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
//
// ADMIN_ROWS_GRANTABLE_V1 (2026-09-26) — три прибавки, каждая узкая:
//   • «Удаление» плитки открывает DELETE — только по таблицам этой плитки и
//     только там, где реестр даёт удаление администратору (у строки должен
//     быть уровень «Удаление»: оборудование «Помещений»);
//   • действие «Цены и проценты» плитки (`of`) открывает её денежные колонки
//     (`moneyColumns`) сверх `grantColumns`;
//   • `grantOps` плитки сужает операции: ключ API право только правит
//     (переименовать, отозвать), создаёт — администратор;
//   • ЧТЕНИЕ таблицы, которую реестр отдаёт одному администратору (api_tokens),
//     открывает «Просмотр» плитки — с замаскированными колонками `read.secret`
//     (readGrantAllows / secretColumns; маскирует query-compiler.js).
import { writeGrantKey, tableEntry, writableColumns } from './schema-registry.js';
import { grantAllowsOr, isAdminUser } from '../services/grants.js';
import { catalogByKey, moneyRowOf } from '../../public/js/shared/permission-catalog.js';

const GRANTABLE_OPS = new Set(['insert', 'update', 'delete']);
// Какой уровень строки нужен операции.
const OP_NEED = { insert: 'edit', update: 'edit', delete: 'delete' };
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
  const need = OP_NEED[op];
  if (!row || row.locked || !Array.isArray(row.levels) || !row.levels.includes(need)) return false;
  const ops = row.grantOps && row.grantOps[table];
  if (Array.isArray(ops) && !ops.includes(op)) return false;
  try {
    // Прежнее правило — «нет»: ненастроенный ключ ничего не прибавляет, пишет
    // тот, кого пускает реестр.
    return grantAllowsOr(db, user, key, need, () => false);
  } catch {
    return false;   // права не прочитались — самый узкий доступ
  }
}

/**
 * ADMIN_ROWS_GRANTABLE_V1 — читать таблицу, которую реестр отдаёт только
 * администратору, может тот, кому её плитка выдана хотя бы на «Просмотр».
 * Секретные колонки такой читатель получает замаскированными (secretColumns).
 */
export function readGrantAllows(table, user, db) {
  if (!db || !user) return false;
  const key = writeGrantKey(table);
  const row = key ? rowOf(key) : null;
  if (!row || row.locked) return false;
  try { return grantAllowsOr(db, user, key, 'view', () => false); }
  catch { return false; }
}

/** Колонки, которые читатель по праву плитки видит только замаскированными. */
export function secretColumns(table) {
  const e = tableEntry(table);
  return e && e.read && Array.isArray(e.read.secret) ? e.read.secret : [];
}

/** Выдано ли действие «Цены и проценты» той плитки, которой принадлежит таблица. */
function moneyGranted(table, user, db) {
  const key = writeGrantKey(table);
  const money = key ? moneyRowOf(key) : null;
  if (!money || !money.moneyColumns || !money.moneyColumns[table] || !db || !user) return null;
  try { return grantAllowsOr(db, user, money.key, 'edit', () => false) ? money.moneyColumns[table] : null; }
  catch { return null; }
}

/**
 * Колонки таблицы, которые вправе писать право окна (а не администратор), —
 * или null, если у плитки для этой таблицы ограничений нет.
 */
export function grantColumnsFor(table, user = null, db = null) {
  const key = writeGrantKey(table);
  const row = key ? rowOf(key) : null;
  const cols = row && row.grantColumns && row.grantColumns[table];
  if (!Array.isArray(cols)) return null;
  // ADMIN_ROWS_GRANTABLE_V1 — «Цены и проценты» открывают деньги плитки.
  const money = moneyGranted(table, user, db);
  return money ? [...cols, ...money] : cols;
}

/**
 * Первая колонка записи, которую право окна писать НЕ вправе (цена, процент,
 * ставка…), — или null. Колонки вне реестра не в счёт: компилятор их и так
 * отбрасывает.
 */
export function writeGrantViolation(table, op, values, user = null, db = null) {
  const allowed = grantColumnsFor(table, user, db);
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
export function writeGrantNarrows(table, user, db, op = 'update') {
  if (!db || !user || !isAdminUser(user)) return false;
  const key = writeGrantKey(table);
  if (!key) return false;
  // ADMIN_ROWS_GRANTABLE_V1 — удаление сужает «Удаление» строки, если оно у
  // строки есть; иначе, как и прежде, её «Изменение».
  const row = rowOf(key);
  const need = op === 'delete' && row && Array.isArray(row.levels) && row.levels.includes('delete') ? 'delete' : 'edit';
  try {
    return !grantAllowsOr(db, user, key, need, () => true);
  } catch {
    return false;
  }
}
