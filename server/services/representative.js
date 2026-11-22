// REP_OWN_DOCTORS_V1 (2026-11-18) — КТО МЕДПРЕДСТАВИТЕЛЬ. Одно определение на
// всю программу: им пользуются экран «Реферирование» (rpc/referrals.js), бот
// представителей (rep-bot) и ограничение строк referral_sources в компиляторе
// запросов (db/pay-visibility.js, правило `not_representative`).
//
// Владелец (2026-11-18): «Med rep should not see internal doctors and they only
// have to see only their own doctors on their name, and even they shouldn't see
// other med rep's doctors also».
//
// Отдельный маленький модуль, а не rpc/referrals.js: компилятор запросов
// (через pay-visibility.js) не должен тянуть за собой отчёты, которые
// импортирует referrals.js.
import { isAdminUser } from './grants.js';

export const REPRESENTATIVE_ROLE = 'medrep';   // custom_roles.code, заведён миграцией 252
// FIX_318_V1 (L4) — у клиники, заведшей свою роль «Медпредставитель» до 252,
// роль живёт под своим кодом (мигр. 258 убирает дубль medrep, который никто не
// носит): её сотрудники — тоже представители. Имя роли — как его пишет клиника.
const REPRESENTATIVE_ROLE_NAMES = ['Медпредставитель', 'медпредставитель', 'МЕДПРЕДСТАВИТЕЛЬ'];

export function representativeCodes(db) {
  const codes = new Set([REPRESENTATIVE_ROLE]);
  try {
    for (const r of db.prepare(`SELECT code FROM custom_roles WHERE trim(name) IN (${REPRESENTATIVE_ROLE_NAMES.map(() => '?').join(',')})`)
      .all(...REPRESENTATIVE_ROLE_NAMES)) codes.add(String(r.code));
  } catch { /* база без custom_roles — только medrep */ }
  return [...codes];
}

/**
 * Работает ли этот человек медпредставителем — и, значит, видит только
 * закреплённых за ним внешних врачей. Роль клиники — основная
 * (users.custom_role_code), как у списка представителей вкладки. Администратор
 * представителем не считается никогда: ему видно всё.
 */
export function isRepresentative(db, user) {
  if (!user || isAdminUser(user)) return false;
  const code = typeof user.custom_role_code === 'string' ? user.custom_role_code.trim() : '';
  if (!code) return false;
  if (code === REPRESENTATIVE_ROLE) return true;
  if (!db) return false;
  return representativeCodes(db).includes(code);
}
