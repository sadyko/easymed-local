// Single source of truth for user roles. The frontend mirrors this list;
// route modules re-export it so services never import from routes.
// CALLCENTER_ROLE_V1 — 'callcenter' is the phone operator who runs the CRM
// board. It exists because the clinic had been repurposing 'inventory' for the
// job and widening one account with the registrar role as an extra, which hands
// a phone operator the whole registrar right set (patients, visits, invoices).
export const VALID_ROLES = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse', 'inventory', 'callcenter'];

// MULTI_ROLE_SERVER_V1 — every role a request may be authorised by: the primary
// role plus «Дополнительные роли» (users.extra_roles, admin-only to set). The
// ACL layer asks for this rather than reading user.role, because a склад
// employee given the registrar role as an extra was shown the CRM board by the
// client and then refused by the server on save — the extras had never reached
// it. Order matters only for readability: the primary role stays first.
export function effectiveRoles(user) {
  if (!user || !user.role) return [];
  const extra = Array.isArray(user.extra_roles) ? user.extra_roles : [];
  return [...new Set([user.role, ...extra].filter((r) => typeof r === 'string' && r))];
}

// Does this user hold ANY of `allowed`, counting extras? The RPC capability
// guards ask this; they each used to test `allowed.includes(user.role)`, which
// is the same primary-role-only bug the ACL layer had.
export function hasAnyRole(user, allowed) {
  const mine = effectiveRoles(user);
  return mine.some((r) => allowed.includes(r));
}

// TELEGRAM_CHAT_V1 — уровень доступа к разделу по таблице role_permissions.
//
// До сих пор гарды RPC перечисляли роли прямо в коде («admin, registrar»), и
// этого хватало: набор разделов был фиксирован. Но «Чат с пациентами» выдаётся
// администратором в «Настройки → Роли», то есть набор ролей заранее неизвестен,
// и проверять его надо ТАМ ЖЕ, где он хранится.
//
// Возвращает 'viewer' | 'editor' | 'admin' — или null, если раздел не выдан.
// Ключ, выданный без явного уровня, считается 'admin': так же поступает
// клиентский permissions.js, и роли, настроенные до появления уровней, не
// должны молча терять права.
const LEVEL_RANK = { viewer: 1, editor: 2, admin: 3 };

export function sectionLevel(db, user, key) {
  const roles = effectiveRoles(user);
  if (!roles.length) return null;

  let best = null;
  for (const role of roles) {
    let row;
    try { row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role); }
    catch { row = null; }
    if (!row || !row.permissions) continue;

    let perms;
    try { perms = JSON.parse(row.permissions); } catch { continue; }
    const sections = Array.isArray(perms && perms.sections) ? perms.sections : [];
    if (!sections.includes(key)) continue;

    const lvl = (perms.levels && perms.levels[key]) || 'admin';
    if (!best || (LEVEL_RANK[lvl] || 0) > (LEVEL_RANK[best] || 0)) best = lvl;
  }
  return best;
}

// Может ли пользователь хотя бы смотреть раздел?
export function canViewSection(db, user, key) {
  return sectionLevel(db, user, key) != null;
}

// Может ли изменять (для чата — отвечать пациенту)?
export function canEditSection(db, user, key) {
  const lvl = sectionLevel(db, user, key);
  return lvl === 'editor' || lvl === 'admin';
}
