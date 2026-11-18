// CALLCENTER_NO_DISCOUNT_V1 (3.25.0, владелец: «they create booking only, they
// cannot set the discount») — ГРУППУ СО СКИДКОЙ КОЛЛ-ЦЕНТР НЕ СТАВИТ.
//
// Оператор колл-центра заводит карту пациента из заявки CRM (окно «Пациент из
// заявки» — блок реквизитов быстрой регистрации). В окне есть «Тип скидки» —
// категория пациента (patients.category_id), и категория со скидкой делает
// скидку на КАЖДЫЙ счёт этого пациента сама: процент группы — полом скидки
// счёта (DISCOUNT_V2), ставки по услугам — своими скидками строк
// (DISCOUNT_RATES_V1). Выбор оператора, который записывает, а не продаёт,
// становился деньгами клиники. Дата рождения к тому же сама подставляла
// «Взрослый» / «Ребёнок» / «Новорождённый» — с их скидкой, если она у клиники есть.
//
// Правило одно на экран (patient-create-modal.js) и сервер (routes/db.js,
// server/services/domain/patient-category-guard.js). Модуль чистый: без DOM и
// без перевода — сервер импортирует его так же, как остальные shared/*.

import { parseRates } from '../admin/discount-rates.js';

/**
 * Несёт ли категория пациента скидку: процент больше нуля или хоть одна ставка
 * по услугам больше нуля (группа со ставками даёт скидку и при 0 % «по
 * умолчанию» — domain/discount-choice.js patientGroupDiscount). Ставки, все
 * равные 0 %, скидки не дают ни на одну строку — такая группа не «со скидкой».
 * Выключенная категория — тоже «со скидкой»: включат — даст скидку.
 * @param {{discount_percent?: number|string|null, discount_rates?: object|string|null}|null} cat
 */
export function categoryCarriesDiscount(cat) {
    if (!cat) return false;
    const pct = Number(cat.discount_percent);
    if (Number.isFinite(pct) && pct > 0) return true;
    const r = parseRates(cat.discount_rates);
    return ['g', 'c', 's'].some((lvl) => Object.values(r[lvl]).some((p) => p > 0));
}

/**
 * Только колл-центр: роль `callcenter` (основная или дополнительная) и ни
 * администратора, ни регистратуры среди ролей. Регистратор с дополнительной
 * ролью колл-центра и администратор ставят группу, как прежде.
 * @param {string[]} roles  основная роль и «Дополнительные роли» вместе
 */
export function callcenterOnly(roles) {
    const list = (Array.isArray(roles) ? roles : []).map((r) => String(r == null ? '' : r).trim().toLowerCase());
    return list.includes('callcenter') && !list.includes('admin') && !list.includes('registrar');
}

/** Текст отказа сервера — ключ словаря (i18n-strings.js), экран переводит его tr(). */
export const CALLCENTER_DISCOUNT_REFUSAL = 'Группу пациента со скидкой колл-центр не выбирает и не меняет — её ставят регистратура или администратор.';
