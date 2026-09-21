// GRANTS_V1 (2026-09-18) — ПРАВА ПО СПРАВОЧНИКУ: ОДНА ПРОВЕРКА НА ВСЕ ВОРОТА.
//
// Владелец: «we need to setup a roles and permissions as they should … by every
// section and every option of the section … also actions like, in the
// stationary, adding prescriptions, adding measurements etc.».
//
// ЧТО БЫЛО. Ворота RPC перечисляли роли прямо в коде: MARK_ROLES = ['nurse',
// 'senior_nurse', 'admin'] и так далее, десятки списков. Экран «Роли» об этих
// списках не знал и знать не мог — поэтому галочка «Стационар» открывала
// раздел, а что в нём можно ДЕЛАТЬ, решал код, и поменять это заведующая не
// могла ни одной настройкой.
//
// ЧТО ТЕПЕРЬ. У роли в role_permissions появился словарь grants:
//     { "inpatient.vitals": "edit", "inpatient.prescriptions": "view", … }
// Ключи — из общего справочника public/js/shared/permission-catalog.js (его же
// рисует экран «Роли»). Ворота спрашивают requireGrant(): выдан ли уровень.
//
// ПРАВИЛО ПЕРЕХОДА, и оно главное. Пока у роли нет записи по ключу, действует
// ПРЕЖНИЙ список ролей из кода — тот самый, что работал до этого дня. Никакая
// клиника после обновления не проснётся с медсёстрами, которым запрещено
// отмечать назначения: молчание настройки значит «как было», а не «нельзя».
// Запрет появляется только там, где заведующая его сама поставила.
//
// НЕСКОЛЬКО РОЛЕЙ — САМАЯ ЩЕДРАЯ, как и у разделов (roles.js sectionLevel):
// дополнительная роль — прибавка, а не урезание. Своя роль клиники ЗАМЕНЯЕТ
// основу (CUSTOM_ROLES_V1), и если строки для неё ещё нет — считаем по основе.
import { permissionRoles, effectiveRoles, hasAnyRole } from './roles.js';
import { CATALOG, levelAllows, LEVELS } from '../../public/js/shared/permission-catalog.js';
import { RpcError } from './rpc/inpatient-flow.js';

const RANK = { none: 0, view: 1, edit: 2, delete: 3 };

// Отказ ворот — тот же RpcError, что у всех ворот стационара: тесты и
// обработчики ловят его через `instanceof RpcError`, и отказ по матрице
// прав не должен для них выглядеть чужим.
export class GrantError extends RpcError {
  constructor(message, status = 403) { super(message, status); }
}

function rolesForGrants(db, user) {
  const list = permissionRoles(user);
  const custom = user && typeof user.custom_role_code === 'string' ? user.custom_role_code.trim() : '';
  if (!custom) return list;
  let has = false;
  try { has = !!db.prepare('SELECT 1 FROM role_permissions WHERE role = ?').get(custom); } catch { has = false; }
  return has ? list : effectiveRoles(user);
}

function grantsOfRole(db, role) {
  let row;
  try { row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role); }
  catch { row = null; }
  if (!row || !row.permissions) return null;
  let perms;
  try { perms = JSON.parse(row.permissions); } catch { return null; }
  return perms && perms.grants && typeof perms.grants === 'object' ? perms.grants : null;
}

/**
 * Уровень по ключу справочника для этого человека — 'none'|'view'|'edit'|'delete',
 * или null, если НИ ОДНА из его ролей этот ключ не настраивала (тогда ворота
 * живут по прежнему списку ролей).
 */
export function grantLevel(db, user, key) {
  const roles = rolesForGrants(db, user);
  let best = null;
  for (const role of roles) {
    const g = grantsOfRole(db, role);
    if (!g || !(key in g)) continue;
    const lvl = LEVELS.includes(g[key]) ? g[key] : 'none';
    if (best === null || (RANK[lvl] || 0) > (RANK[best] || 0)) best = lvl;
  }
  return best;
}

// Ключи РАЗДЕЛОВ справочника: по ним ворота узнают, в каком разделе живёт окно
// или действие («custdev.list» → «custdev»). Набор берётся из самого
// справочника, а не из разбора строки: ключ с точкой, чей левый кусок разделом
// не является, разделом и не считается.
const SECTION_KEYS = new Set(CATALOG.map((s) => s.key));

function sectionOf(key) {
  const i = String(key).indexOf('.');
  if (i <= 0) return null;
  const head = String(key).slice(0, i);
  return SECTION_KEYS.has(head) ? head : null;
}

/** Словарь СВОЕЙ роли клиники (CUSTOM_ROLES_V1), если такая роль настроена. */
function ownCustomGrants(db, user) {
  const custom = user && typeof user.custom_role_code === 'string' ? user.custom_role_code.trim() : '';
  return custom ? grantsOfRole(db, custom) : null;
}

/**
 * АДМИНИСТРАТОР КЛИНИКИ — ОДИН ПРЕДИКАТ НА ВСЮ ПРОГРАММУ.
 *
 * hasAnyRole, а не `user.role === 'admin'`: у администратора клиники ОСНОВНАЯ
 * роль сплошь и рядом `doctor`, а `admin` стоит дополнительной — он же и
 * принимает пациентов (ADMIN_DOCTOR_V1; тот же предикат у rpc/backup.js,
 * rpc/telephony.js requireAdmin, rpc/updates.js).
 */
export function isAdminUser(user) {
  return hasAnyRole(user, ['admin']);
}

/**
 * Пускать ли: настроенный уровень, а если его нет — ПРЕЖНЕЕ ПОВЕДЕНИЕ, которое
 * зовущий описывает сам (`legacy`). У ворот со списком ролей в коде это
 * hasAnyRole по списку (обёртка grantAllows ниже), у Cust Dev — прежняя
 * галочка раздела (rpc/custdev.js): правило же перехода и все поправки к нему
 * обязаны быть ОДНИ на обоих, иначе ворота разойдутся в первый же выпуск.
 */
export function grantAllowsOr(db, user, key, need, legacy) {
  // АДМИНИСТРАТОР ПРОХОДИТ, ПОКА ЕМУ САМОМУ НИЧЕГО НЕ НАСТРОИЛИ, и это не
  // поблажка, а согласие с экраном: строки штатного администратора в
  // «Настройки → Роли» нет (roles-editor.js ROLE_LIST), матрицу ему не
  // записать, и «Нет» у него взяться неоткуда. А вот ЧУЖОЕ «Нет» прочиталось
  // бы: у администратора клиники основная роль сплошь и рядом `doctor`, а
  // `admin` стоит дополнительной (ADMIN_DOCTOR_V1), и заведующий остался бы
  // без звонка и без записи разговора ровно потому, что клиника (или миграция
  // 141) закрыла эти ключи ВРАЧАМ.
  //
  // НО СВОЯ РОЛЬ КЛИНИКИ НА ОСНОВЕ АДМИНИСТРАТОРА — ЭТО УЖЕ ЕГО СОБСТВЕННОЕ
  // «НЕТ». routes/users.js пишет в users.role ОСНОВУ роли, поэтому «Старший
  // администратор» читается как `admin`, — и безусловный пропуск отменял бы
  // каждый запрет в матрице, которую для этой роли и заводили: экран показывал
  // бы права, которых у человека нет. Поэтому поблажка кончается там, где у
  // СВОЕЙ роли человека есть запись по этому ключу или по его разделу.
  const own = ownCustomGrants(db, user);
  const section = sectionOf(key);
  const mine = !!own && (key in own || (section !== null && section in own));
  if (isAdminUser(user) && !mine) return true;

  // ЗАКРЫТЫЙ РАЗДЕЛ ЗАКРЫВАЕТ ВСЁ, ЧТО В НЁМ. Уровни окон и действий остаются
  // лежать в матрице и после того, как раздел поставили в «Нет»: экран их
  // гасит, но значения у них прежние, и такая запись доезжает до базы. Спроси
  // ворота только про окно — и закрытый раздел открылся бы изнутри: «Cust Dev:
  // Нет» при «Доска обзвона: Просмотр» пускало бы на доску закрытого раздела,
  // хотя до появления строк матрицы одна галочка раздела отказывала.
  if (section !== null && grantLevel(db, user, section) === 'none') return false;

  const lvl = grantLevel(db, user, key);
  if (lvl !== null) return levelAllows(lvl, need);
  return legacy();
}

/**
 * Пускать ли: настроенный уровень, а если его нет — прежний список ролей.
 * @param {string[]} fallbackRoles  тот самый список из кода, что работал до grants
 */
export function grantAllows(db, user, key, need, fallbackRoles = []) {
  return grantAllowsOr(db, user, key, need, () => hasAnyRole(user, fallbackRoles));
}

/**
 * Ворота: бросает 403 с человеческой фразой, если не пускать. `what` —
 * сказуемое для сообщения: «добавлять назначения», «записывать измерения».
 */
export function requireGrant(db, user, key, need, fallbackRoles, what = '') {
  if (grantAllows(db, user, key, need, fallbackRoles)) return;
  // Формат отказа — тот же, что у всех ворот стационара («… — недоступно
  // вашей роли»): человек узнаёт его с первого взгляда, а хвост говорит, где
  // право выдают.
  const w = String(what || 'Это действие').trim();
  const head = w.charAt(0).toUpperCase() + w.slice(1);
  throw new GrantError(`${head} — недоступно вашей роли. Права выдаёт администратор в «Настройки → Роли».`);
}
