// ADMIN_ROWS_GRANTABLE_V1 (ревью безопасности, финал — мелочь 3) — НОВАЯ СВОЯ
// РОЛЬ КЛИНИКИ ОДНИМ ДЕЙСТВИЕМ.
//
// Экран «Роли» заводил роль двумя записями через /api/db: строку custom_roles,
// а потом копию прав основы в role_permissions. У не-администратора вторую
// запись справедливо отклоняла защита «Ролей» (копия основы шире его
// собственных прав) — и в базе оставалась роль без прав: полроли, которую
// можно выдать человеку. Здесь обе записи делаются в одной транзакции, а
// права новой роли — права основы, срезанные до уровня того, кто её заводит
// (role-guard.js permissionsCappedFor). Не сложилось — не записано ничего.
import { isAdminUser, grantAllowsAdminOr } from '../grants.js';
import { effectiveRoles, PRIMARY_ROLES, VALID_ROLES } from '../roles.js';
import { permsOfRole, permissionsCappedFor, roleExceedsActor, actorGrantRank, levelNameOfRank } from '../role-guard.js';
import { readIdentity } from '../branch-sync/identity.js';
import { MAIN_CLINIC_TABLES } from '../../db/schema-registry.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isSecondary(db) {
  try { return readIdentity(db).role === 'secondary'; } catch { return false; }
}

/**
 * args: { code, name, base_role } → { code, name, base_role, active }.
 * Администратор — с правами основы целиком, как и раньше; «Роли: Изменение» —
 * только на своей основе и с правами не выше своих.
 */
export function customRoleCreate(db, args, user) {
  if (!user) throw new RpcError('Войдите в систему.', 401);
  if (!grantAllowsAdminOr(db, user, 'settings.roles', 'edit')) {
    throw new RpcError('Заводить роли может администратор или роль с «Роли: Изменение».', 403);
  }
  const a = args || {};
  const code = String(a.code || '').trim();
  const name = String(a.name || '').trim().slice(0, 80);
  const base = String(a.base_role || '').trim();
  if (!name) throw new RpcError('Введите название роли.', 400);
  if (!CODE_RE.test(code) || VALID_ROLES.includes(code)) throw new RpcError('Код роли — строчные латинские буквы, цифры, «-» и «_», не занятый штатной ролью.', 400);
  if (!PRIMARY_ROLES.includes(base)) throw new RpcError('Неизвестная основа роли.', 400);
  if (isSecondary(db)) throw new RpcError(MAIN_CLINIC_TABLES.role_permissions, 409);
  const admin = isAdminUser(user);
  if (!admin && (base === 'admin' || !effectiveRoles(user).includes(base))) {
    throw new RpcError('Основой своей роли может быть только роль, которую вы носите сами (и не администратор).', 403);
  }
  if (db.prepare('SELECT 1 FROM custom_roles WHERE code = ?').get(code) || db.prepare('SELECT 1 FROM role_permissions WHERE role = ?').get(code)) {
    throw new RpcError('Роль с таким кодом уже есть.', 409);
  }
  const basePerms = permsOfRole(db, base) || { sections: [], levels: {}, patient_tabs: {} };
  const perms = admin ? basePerms : permissionsCappedFor(db, user, basePerms);

  db.transaction(() => {
    db.prepare('INSERT INTO custom_roles (code, name, base_role, active) VALUES (?, ?, ?, 1)').run(code, name, base);
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(code, JSON.stringify(perms));
    if (admin) return;
    // Ключ, который роль получила бы по основе (ворота по списку ролей), а
    // правящий — нет, записывается явно на его уровне. Иначе такую роль он
    // тут же не смог бы никому выдать.
    for (let i = 0; i < 200; i++) {
      const excess = roleExceedsActor(db, user, code);
      if (!excess) return;
      const m = /право «([^»]+)»/.exec(excess);
      if (!m) throw new RpcError('Новая роль вышла бы шире ваших прав (' + excess + ').', 403);
      perms.grants = { ...(perms.grants || {}), [m[1]]: levelNameOfRank(actorGrantRank(db, user, m[1])) };
      db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), code);
    }
    throw new RpcError('Не удалось срезать права новой роли до ваших.', 403);
  })();
  return { code, name, base_role: base, active: 1 };
}
