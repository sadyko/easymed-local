// Single source of truth for user roles. The frontend mirrors this list;
// route modules re-export it so services never import from routes.
// CALLCENTER_ROLE_V1 — 'callcenter' is the phone operator who runs the CRM
// board. It exists because the clinic had been repurposing 'inventory' for the
// job and widening one account with the registrar role as an extra, which hands
// a phone operator the whole registrar right set (patients, visits, invoices).
// Роли, которые человек носит КАК ОСНОВНУЮ: это его профессия в клинике, и
// именно по ней реестр таблиц (schema-registry.js) выдаёт права на данные.
export const PRIMARY_ROLES = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse', 'inventory', 'callcenter'];

// INPATIENT_FLOW_V1 — НАДСТРОЕЧНЫЕ роли: только через «Дополнительные роли».
//
// «Главный врач» и «старшая медсестра» — не профессии, а полномочия ПОВЕРХ
// профессии: главный врач остаётся врачом (ведёт своих пациентов, свою очередь,
// свой кабинет) и вдобавок проводит первичный осмотр и назначает лечащего
// врача. Решение владельца дословно: «„Главный врач“ — роль, её может держать
// несколько врачей».
//
// Основной ролью они быть НЕ МОГУТ, и это не вкусовщина: в списках реестра
// (ALL_STAFF и все write.roles) слова 'head_doctor' нет ни в одной строке, так
// что человек с такой ОСНОВНОЙ ролью увидел бы пустое приложение. Сервер
// авторизует по ОБЪЕДИНЕНИЮ основной и дополнительных (effectiveRoles ниже),
// поэтому врач с надстройкой имеет и права врача, и права главного врача.
//
// routes/users.js проверяет основную роль по PRIMARY_ROLES, а дополнительные —
// по VALID_ROLES. Разница намеренная, и объявлена она здесь.
export const EXTRA_ONLY_ROLES = ['head_doctor', 'senior_nurse'];

// Всё, что человек вправе носить в любом качестве.
export const VALID_ROLES = [...PRIMARY_ROLES, ...EXTRA_ONLY_ROLES];

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
