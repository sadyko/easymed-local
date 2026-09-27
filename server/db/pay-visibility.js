// FINAL_ROLES_SYNC_FIX_V1 (M1, 2026-09-27) — КТО ВИДИТ СТАВКИ ВРАЧЕЙ.
//
// Ставки врачей (doctor_rates) и доля врача по умолчанию у услуги
// (services.default_doctor_percent и ступени doctor_tier_*) реестр отдавал
// всему персоналу: регистратура и касса через /api/db читали, сколько получает
// каждый врач с каждой услуги, хотя отчёт «Оплата врачей» им закрыт.
//
// Видят их те же, кто видит начисления врачей:
//   • администратор;
//   • кому выдана группа отчётов «Оплата врачей» (reports.doctor_pay) — по тому
//     же правилу, что и сами отчёты (report-access.js canSeeReportKey);
//   • кому выдана плитка «Ставки врачей» (settings.doctor_rates) хотя бы на
//     «Просмотр» (ненастроенная — только администратор, adminDefault).
// Свои строки ставок врач видит всегда (schema-registry: doctor_rates.scope,
// колонка doctor_id).
//
// Без базы (компилятор вызван без контекста) ответ самый узкий: только роли.
import { isAdminUser, grantAllowsAdminOr } from '../services/grants.js';
import { canSeeReportKey } from '../services/report-access.js';

export function seesDoctorPay(db, user) {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  if (!db) return false;
  try {
    return canSeeReportKey(db, user, 'reports.doctor_pay')
      || grantAllowsAdminOr(db, user, 'settings.doctor_rates', 'view');
  } catch {
    return false;   // права не прочитались — самый узкий доступ
  }
}

/** Именованные правила «кто видит всё», на которые ссылается реестр (`lift`). */
export const LIFTS = Object.freeze({ doctor_pay: seesDoctorPay });

export function liftAllows(name, db, user) {
  const fn = name ? LIFTS[name] : null;
  return typeof fn === 'function' ? !!fn(db, user) : false;
}
