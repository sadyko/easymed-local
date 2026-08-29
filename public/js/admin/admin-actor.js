// SETTINGS_SPLIT_V1 (2026-08-29, owner: «в подписке оставить только подписку и
// статус модулей (с запросом), а в системе — только версию и что нового») — the
// "is the CURRENT actor an admin" verdict, extracted here because the split
// gave it THREE screens instead of one: «Система» (views/updates.js),
// «Подписка» (views/subscription.js) and «Данные клиники»
// (views/clinic-data.js) all render admin-only controls and must agree.
//
// It lived as a private isAdminActor() inside views/updates.js, whose own
// comment already warned against making "a fourth slightly-different copy" of
// the rule that cashier-desk.js's isGeneralAdmin() and telegram-chat.js's
// canBroadcast() implement. Splitting the page would have created exactly
// that, twice — so the function moved instead of being copied, and the two new
// screens import it.
//
// The rule, unchanged: primary role OR 'admin' in extra_roles, never
// `user.role === 'admin'` alone. (window.easymed.state.user does not currently
// carry `extra_roles` — see those two files' own history — so the fallback is
// inert today exactly as theirs is; it stays so all call sites move together
// the day that gap is closed, instead of fixing one and leaving the rest
// silently behind again.)
//
// Politeness only, everywhere it is used: every RPC re-checks the role
// server-side no matter what renders.

export function isAdminActor() {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    if (!u) return false;
    if (u.is_super_admin === true || u.is_admin === true) return true;
    const extra = Array.isArray(u.extra_roles) ? u.extra_roles : [];
    return [u.role, ...extra].includes('admin');
}
