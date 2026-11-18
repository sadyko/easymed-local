// CALLCENTER_NO_DISCOUNT_V1 (3.25.0, владелец: «they create booking only, they
// cannot set the discount») — СЕРВЕРНЫЙ ЗАМОК: ГРУППУ ПАЦИЕНТА СО СКИДКОЙ
// ТОЛЬКО-КОЛЛ-ЦЕНТР НЕ СТАВИТ И НЕ МЕНЯЕТ.
//
// Реестр таблиц (schema-registry.js) даёт роли `callcenter` вставку в patients
// со всеми колонками карты — и category_id тоже: оператор заводит карту из
// заявки CRM. Категория со скидкой (процент или ставки по услугам) даёт скидку
// на каждый счёт пациента сама (DISCOUNT_V2, DISCOUNT_RATES_V1), поэтому выбор
// оператора становился деньгами клиники. Экран больше не предлагает такие
// категории оператору (patient-create-modal.js), но экран — не граница:
// проверка стоит здесь, у записи.
//
// Правило (shared/patient-category-discount.js — одно с экраном):
//   • только колл-центр — роль `callcenter` и ни администратора, ни
//     регистратуры среди основной и дополнительных ролей (effectiveRoles);
//     регистратура и администратор — как прежде, без ограничений;
//   • новая карта с категорией со скидкой — отказ; категория без скидки
//     (возрастная группа 0 %) и пустая — можно;
//   • правка карты: нельзя поставить категорию со скидкой и нельзя снять или
//     сменить уже стоящую категорию со скидкой; то же значение, что было, —
//     не правка категории.
// Уже записанные категории пациентов правило не трогает: оно смотрит только
// на запись, которую делают сейчас.
import { effectiveRoles } from '../roles.js';
import { categoryCarriesDiscount, callcenterOnly, CALLCENTER_DISCOUNT_REFUSAL } from '../../../public/js/shared/patient-category-discount.js';

export { CALLCENTER_DISCOUNT_REFUSAL };

/** Только колл-центр (роли сессии: основная и «Дополнительные роли»). */
export function isCallcenterOnlyUser(user) {
  return callcenterOnly(effectiveRoles(user));
}

// Пустой выбор списка ('' из браузера) — «без категории», как у компилятора
// запросов (EMPTY_ID_IS_NULL_V1).
const noCategory = (v) => v === undefined || v === null || v === '';

function carries(db, id) {
  if (noCategory(id)) return false;
  const cat = db.prepare('SELECT discount_percent, discount_rates FROM patient_categories WHERE id = ?').get(Number(id));
  return categoryCarriesDiscount(cat || null);
}

/**
 * Текст отказа или null.
 * @param {object} db
 * @param {object} user          сессия (role, extra_roles)
 * @param {object} o
 * @param {*}      o.next        категория, которую пишут
 * @param {Array}  [o.current]   категории правимых карт (у новой карты — пусто)
 */
export function callcenterCategoryRefusal(db, user, { next, current = [] } = {}) {
  if (!isCallcenterOnlyUser(user)) return null;
  const same = (a, b) => (noCategory(a) && noCategory(b)) || (!noCategory(a) && !noCategory(b) && String(a) === String(b));
  if (!current.length) return carries(db, next) ? CALLCENTER_DISCOUNT_REFUSAL : null;
  for (const cur of current) {
    if (same(next, cur)) continue;
    if (carries(db, cur) || carries(db, next)) return CALLCENTER_DISCOUNT_REFUSAL;
  }
  return null;
}
