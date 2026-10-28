// ADMIN_ACT_AS_V1 (2026-10-28) — ПРАВИЛА ВХОДА ОТ ИМЕНИ СОТРУДНИКА (R1, R2, R4).
//
// Спецификация — docs/specs/2026-10-28-admin-act-as-design.md. Одни и те же
// правила спрашивают вход от имени (services/act-as.js — POST /api/auth/act-as)
// и каждое чтение сессии (services/auth.js sessionUser): сотрудник, которого
// нельзя было бы выбрать сейчас, перестаёт быть тем, от чьего имени работают,
// на следующем же запросе.
//
// Администратор — isAdminUser (роль admin основная или дополнительная, R1);
// «как администратора войти нельзя» — isAdminAccount (и своя роль клиники на
// основе администратора, R2). Оба предиката — общие для всей программы.
import { isAdminUser } from './grants.js';
import { isAdminAccount } from './role-guard.js';
import { ACT_AS_END, ACT_AS_MAX_HOURS, ACT_AS_MESSAGES } from '../../public/js/shared/act-as.js';

export const ACT_AS_MAX_MS = ACT_AS_MAX_HOURS * 3600 * 1000;

const refusal = (status, code, message) => ({ status, code, message });

/**
 * R1 — может ли пользователь сессии начать вход от имени: отказ
 * { status, code, message } или null. Только администратор из своей обычной
 * сессии: не уже от имени другого и не с временным паролем.
 */
export function actAsStartRefusal(user) {
  if (!user) return refusal(401, 'unauthorized', 'Нужно войти в систему.');
  if (user.acting_admin) return refusal(403, 'forbidden', ACT_AS_MESSAGES.already);
  if (!isAdminUser(user)) return refusal(403, 'forbidden', ACT_AS_MESSAGES.notAdmin);
  if (user.must_change_password) return refusal(403, 'password_change_required', ACT_AS_MESSAGES.password);
  return null;
}

/**
 * R2 — можно ли войти от имени этого сотрудника: отказ или null. target —
 * строка users (колонки сессии, extra_roles — строкой из базы) или undefined.
 * Только активный, уже входивший сотрудник, не сам администратор и не
 * администратор вообще.
 */
export function actAsTargetRefusal(db, adminId, target) {
  if (!target) return refusal(404, 'not_found', ACT_AS_MESSAGES.notFound);
  if (Number(target.id) === Number(adminId)) return refusal(400, 'bad_request', ACT_AS_MESSAGES.self);
  if (isAdminAccount(db, target)) return refusal(400, 'bad_request', ACT_AS_MESSAGES.targetAdmin);
  if (!target.is_active) return refusal(400, 'bad_request', ACT_AS_MESSAGES.targetInactive);
  if (target.must_change_password) return refusal(400, 'bad_request', ACT_AS_MESSAGES.targetNew);
  return null;
}

/**
 * R4 — причина, по которой вход от имени кончается на этом запросе, или null:
 *   • администратор больше не администратор (или ему сбросили пароль) — «Сессия завершена»;
 *   • 2 часа с начала — «Истекло»;
 *   • сотрудник отключён, удалён, стал администратором или получил временный
 *     пароль (тот же R2) — «Сотрудник недоступен».
 * Отключённого администратора здесь нет: его сессия кончается раньше, целиком.
 */
export function actAsEndCause(db, { admin, target, startedAt, now = Date.now() }) {
  if (!isAdminUser(admin) || admin.must_change_password) return ACT_AS_END.session;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || now >= started + ACT_AS_MAX_MS) return ACT_AS_END.expired;
  if (actAsTargetRefusal(db, admin.id, target)) return ACT_AS_END.unavailable;
  return null;
}
