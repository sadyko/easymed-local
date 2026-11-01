// CLINIC_NEWS_STRIP_V1 — кто видит полосу «Новости клиники» (clinic-news-strip.js).
// Отдельным файлом без DOM: правило проверяется тестом без браузера.
//
// Регистратура, call-центр и администратор (actorRoleCodes: основная,
// дополнительные, основа своей роли клиники) — но не медпредставитель: его
// роль клиники medrep стоит на основе call-центра (мигр. 252), а у стойки он
// не работает.
//
// Администратор сначала был исключён («объявления пишет он сам»); владелец,
// не увидев полосы под администратором: «put to admin role to» — он видит то
// же, что стойка, и проверяет, как объявление читается, не меняя пользователя.
export const STRIP_ROLES = ['registrar', 'callcenter', 'admin'];
const NOT_FOR_CUSTOM = ['medrep'];

export function newsStripAudience(user, roleCodes) {
    if (!user) return false;
    const custom = typeof user.custom_role_code === 'string' ? user.custom_role_code.trim().toLowerCase() : '';
    if (custom && NOT_FOR_CUSTOM.includes(custom)) return false;
    const roles = (roleCodes || []).map((r) => String(r).toLowerCase());
    return roles.some((r) => STRIP_ROLES.includes(r));
}
