// DISCOUNT_V2 (решение владельца 2026-11-07, п. 4) — ВЫБОР ОДНОЙ СКИДКИ В ОКНАХ
// РЕГИСТРАЦИИ (мастер визита, быстрая регистрация, калькулятор услуг).
//
// Окно показывает ВСЕ скидки, которые подходят пациенту: скидку его группы («Скидка
// группы «VIP» — 10%»), промокоды клиники, подходящие сегодня и к этой смете
// (discount-rules.js — то же правило, что у сервера), «Своя скидка (вручную)» и «Без
// скидки». Регистратор выбирает ОДНУ — скидки не складываются; по умолчанию —
// скидка группы, если она есть (как было). Рядом с итогом всегда видно, почему
// скидка такая. Сервер получает выбор (discount_choice / discount_id) и считает
// деньги сам (server/services/domain/discount-choice.js).
//
// Подарочные карты и сертификаты — не скидка, а деньги на карте: ими платят
// (discount-rules.js CARD_BALANCE_V1), поэтому в этом выборе их нет — они остаются
// в выборе «Карта / сертификат» окна.
//
// Чистые функции: без DOM и сети, без текста интерфейса — подписи отдаются
// шаблоном и значениями ({ text, params }); окно переводит их через trf().
import { eligibleDiscounts, isStoredValueCard, serviceScope } from './discount-rules.js';

/** Группа пациента со скидкой: { name, pct } или null. */
export function groupOf(name, pct) {
    const p = Math.min(100, Math.max(0, Number(pct) || 0));
    return p > 0 ? { name: String(name || ''), pct: p } : null;
}

const pctText = (p) => String(Math.round(Number(p) * 100) / 100);

/** Подпись промокода: { text, params } — «Промокод «{name}» — −{value}%» / «… сум» (+ «на выбранные услуги»). */
export function promoLabel(row, fmtMoney) {
    const pct = Number(row && row.percent) || 0;
    const amount = Number(row && row.amount) || 0;
    const value = pct > 0 ? pctText(pct) : (typeof fmtMoney === 'function' ? fmtMoney(amount) : String(amount));
    const scoped = serviceScope(row).length > 0;
    const text = pct > 0
        ? (scoped ? 'Промокод «{name}» — −{value}% · на выбранные услуги' : 'Промокод «{name}» — −{value}%')
        : (scoped ? 'Промокод «{name}» — −{value} сум · на выбранные услуги' : 'Промокод «{name}» — −{value} сум');
    return { text, params: { name: (row && row.name) || '', value } };
}

/**
 * Варианты выбора по порядку: «Без скидки», скидка группы, промокоды, «Своя скидка».
 * @param {{group: {name:string,pct:number}|null, discounts: object[], ctx: object, fmtMoney?: Function, manual?: boolean}} a
 *   ctx — { today, categoryId, serviceIds } (discount-rules.js); manual — показывать «Своя скидка».
 * @returns {Array<{key:string, kind:'none'|'group'|'promo'|'manual', row?:object, label:{text:string, params:object}}>}
 */
export function discountChoiceOptions({ group = null, discounts = [], ctx = {}, fmtMoney = null, manual = true } = {}) {
    const out = [{ key: 'none', kind: 'none', label: { text: 'Без скидки', params: {} } }];
    if (group) out.push({ key: 'group', kind: 'group', label: { text: 'Скидка группы «{name}» — {pct}%', params: { name: group.name, pct: pctText(group.pct) } } });
    for (const row of eligibleDiscounts((discounts || []).filter((d) => !isStoredValueCard(d)), ctx)) {
        out.push({ key: 'promo:' + row.id, kind: 'promo', row, label: promoLabel(row, fmtMoney) });
    }
    if (manual) out.push({ key: 'manual', kind: 'manual', label: { text: 'Своя скидка (вручную)', params: {} } });
    return out;
}

/** Выбор по умолчанию: скидка группы, если она есть, иначе «Без скидки» (как было в 3.21). */
export function defaultChoiceKey(group) {
    return group ? 'group' : 'none';
}

/** Выбор, который ещё есть среди вариантов (смета поменялась — промокод мог перестать подходить). */
export function keepChoice(key, options, group) {
    return (options || []).some((o) => o.key === key) ? key : defaultChoiceKey(group);
}

/** Аргументы счёта по выбору: { discount_choice, discount_id? } (server/services/domain/discount-choice.js). */
export function choiceArgs(key) {
    const k = String(key || '');
    if (k.startsWith('promo:')) return { discount_choice: 'promo', discount_id: Number(k.slice(6)) };
    if (k === 'group' || k === 'none' || k === 'manual') return { discount_choice: k };
    return {};
}

// DISCOUNT_V2 (ревью S1 L-3) — ГРУППА ПАЦИЕНТА НЕ ПРОЧИТАЛАСЬ (сбой сети или базы). Окно не знает,
// есть ли у пациента скидка группы, и его «Без скидки» по умолчанию — не выбор человека: уйдя в
// счёт, оно снимало пол группы, который 3.21 давал всегда. Пока группа не известна и регистратор сам
// ничего не выбрал, выбор не шлётся (null → choiceArgs даёт {}): сервер кладёт пол группы сам, как в
// 3.21. Выбор человека — «Без скидки» тоже — уходит всегда.
/** Выбор, который уходит в счёт: key, или null — группа не известна и человек ничего не выбирал. */
export function choiceToSend(key, { groupKnown = true, picked = false } = {}) {
    return groupKnown || picked ? key : null;
}

/**
 * Выбор калькулятора услуг, когда регистратор не выбирал явно: применённый промокод, своя скидка,
 * скидка группы, иначе «Без скидки»; группа пациента не прочиталась — null (ревью S1 L-3).
 */
export function fallbackChoiceKey({ promoId = null, manualPct = 0, groupPct = 0, groupKnown = true } = {}) {
    if (promoId != null) return 'promo:' + promoId;
    if (Number(manualPct) > 0) return 'manual';
    if (Number(groupPct) > 0) return 'group';
    return groupKnown ? 'none' : null;
}

/** Пол скидки группы, который сервер положит при этом выборе: группа и «вручную» — да, остальные — нет. */
export function choiceFloorPct(key, group) {
    return group && (key === 'group' || key === 'manual') ? group.pct : 0;
}

/**
 * Почему скидка такая — подпись рядом с итогом: { text, params } или null (скидки нет).
 * @param {string} key
 * @param {{group:object|null, promo:object|null, applied:number, floor:number, fmtMoney?:Function}} a
 *   applied — скидка остатка, которую даст счёт; floor — пол группы на эту смету.
 */
export function choiceReason(key, { group = null, promo = null, applied = 0, floor = 0, fmtMoney = null } = {}) {
    if (!(applied > 0)) return null;
    if (key === 'group' && group) return { text: 'Скидка группы «{name}» — {pct}%', params: { name: group.name, pct: pctText(group.pct) } };
    if (String(key).startsWith('promo:') && promo) return promoLabel(promo, fmtMoney);
    if (group && floor > 0 && applied <= floor + 0.5) return { text: 'Скидка группы «{name}» — {pct}%', params: { name: group.name, pct: pctText(group.pct) } };
    return { text: 'Своя скидка (вручную)', params: {} };
}
