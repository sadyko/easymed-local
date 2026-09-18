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
import { levelAllows, LEVELS } from '../../public/js/shared/permission-catalog.js';
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

/**
 * Пускать ли: настроенный уровень, а если его нет — прежний список ролей.
 * @param {string[]} fallbackRoles  тот самый список из кода, что работал до grants
 */
export function grantAllows(db, user, key, need, fallbackRoles = []) {
  const lvl = grantLevel(db, user, key);
  if (lvl !== null) return levelAllows(lvl, need);
  return hasAnyRole(user, fallbackRoles);
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
