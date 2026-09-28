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
import { hasAnyRole } from '../services/roles.js';
// OWN_SHELF_ONLY_V1 — «кто видит склад» живёт у журнала движений (область
// «вся клиника»); здесь на него только ссылается реестр, второго правила нет.
import { canSeeAllMovements } from '../services/rpc/stock-log.js';

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

// V3120_FIX (F1) — ДЕНЬГИ КАРТОЧКИ СОТРУДНИКА (users: оклад, процент, ставки,
// KPI). Видят те, кто видит начисления врачей (seesDoctorPay выше), и те, кому
// выдано «Сотрудники → Цены и проценты» — ровно правило routes/users.js
// employeeMoneyAllowed: окно сотрудников на «Изменение» И действие денег.
export function seesEmployeePay(db, user) {
  if (seesDoctorPay(db, user)) return true;
  if (!user || !db) return false;
  try {
    return grantAllowsAdminOr(db, user, 'settings.employees', 'edit')
      && grantAllowsAdminOr(db, user, 'settings.employees.money', 'edit');
  } catch {
    return false;
  }
}

// OWN_SHELF_ONLY_V1 (владелец 28.09) — ОСТАТОК СКЛАДА ВИДЯТ ТЕ, КТО ВИДИТ СКЛАД.
//
// «when requesting procurement in the cabinet of the doctor or nurse … we don't
// need to see the items that we have in the procurement overall». Врач и
// медсестра выдают пациенту только со своих полок, и общий остаток им не
// нужен, — а через /api/db любой вошедший читал products.on_hand одним
// запросом. Видят его: администратор, кладовщик, роль с разделом «Закупки и
// склад» или с уровнем «Закупки: Просмотр» и выше — ровно те, кому журнал
// движений отдаёт всю клинику (stock-log.js canSeeAllMovements).
export function seesWarehouseStock(db, user) {
  if (!user) return false;
  if (!db) return hasAnyRole(user, ['admin', 'inventory']);   // без базы — только роли
  try {
    return canSeeAllMovements(db, user);
  } catch {
    return false;
  }
}

/** Именованные правила «кто видит всё», на которые ссылается реестр (`lift`). */
export const LIFTS = Object.freeze({ doctor_pay: seesDoctorPay, employee_pay: seesEmployeePay, warehouse_stock: seesWarehouseStock });

export function liftAllows(name, db, user) {
  const fn = name ? LIFTS[name] : null;
  return typeof fn === 'function' ? !!fn(db, user) : false;
}
