// OWN_PRICE_REPEAT_V1 (2026-09-30) — ОДНО ПРАВИЛО ЦЕНЫ СТРОКИ УСЛУГИ.
//
// Владелец: «Own price for repeat too». Своя цена врача
// (users.service_rates[].price) действовала только на первичный приём, а
// второй и повторный визит в окне дней шли по цене каталога для этого визита.
// Теперь:
//   • у врача строки есть своя цена по услуге — она и есть цена строки, на
//     любом ярусе визита (первичный, второй, повторный);
//   • своей цены нет — цена яруса (tierUnitPrice / котировка), а для
//     первичного — каталог, как прежде.
// Ярус строки (price_tier) по-прежнему пишется — по нему считаются визиты;
// меняется только цена.
//
// Правило живёт ЗДЕСЬ и только здесь: его читают сервер (domain/pricing.js
// lineUnitPrice — счёт, «Ждут счёта», правки кассы, доля врача;
// rpc/service-price-quote.js — котировка) и экраны (мастер визита,
// Калькулятор). Вторая копия правила уже однажды разошлась с первой: смета
// называла одно, касса выставляла другое.
//
// Чистые функции: ни сети, ни DOM, ни базы.

/**
 * Сохранённая своя цена → число или null («своей цены нет»).
 * То же условие, что у сервера (domain/pricing.js OWN_PRICE_ENTRY): число JSON
 * или строка из цифр ('80000', '80000.5'), не меньше нуля. Пусто, null,
 * 'abc', отрицательное — своей цены нет, и строка берёт цену яруса. 0 —
 * настоящая бесплатная цена, а не «нет цены».
 *
 * Ревью 1 — строка разбирается РОВНО как у сервера, чтобы смета никогда не
 * разошлась со счётом:
 *   • отбор — trim(...) GLOB '[0-9]*' AND NOT GLOB '*[^0-9.]*': trim SQLite
 *     снимает только пробелы (не табуляцию), первая — цифра, дальше — цифры и
 *     точки;
 *   • число — CAST(... AS REAL): самое длинное начало строки, которое читается
 *     как число, остальное отбрасывается: '80.000.5' → 80, '80.' → 80.
 * (Сам этот разбор у сервера снисходителен — '80.000' читается как 80, а не
 * 80 000; экран его повторяет, а не исправляет: правило одно.)
 */
export function ownPriceValue(price) {
    if (price === null || price === undefined) return null;
    if (typeof price === 'number') return Number.isFinite(price) && price >= 0 ? price : null;
    if (typeof price === 'string') {
        const s = price.replace(/^ +| +$/g, '');
        if (!/^[0-9][0-9.]*$/.test(s)) return null;
        const n = Number(/^[0-9]+(?:\.[0-9]*)?/.exec(s)[0]);
        return Number.isFinite(n) && n >= 0 ? n : null;
    }
    return null;
}

/**
 * Своя цена врача по услуге из его списка ставок (users.service_rates) или
 * null. При дублях услуги в списке берётся первая запись С ЦЕНОЙ — правило
 * сервера (FINAL_MONEY_FIX_V1 M4): ставка без цены своей цены не отменяет.
 */
export function ownPriceFromRates(rates, serviceId) {
    if (!Array.isArray(rates)) return null;
    const sid = String(serviceId);
    for (const r of rates) {
        if (!r || String(r.service_id) !== sid) continue;
        const own = ownPriceValue(r.price);
        if (own !== null) return own;
    }
    return null;
}

/**
 * ЦЕНА СТРОКИ УСЛУГИ: своя цена врача, если она есть, иначе цена яруса визита.
 * `own` — ответ ownPriceValue / ownPriceFromRates / doctorPriceFor (null —
 * своей нет); `tierPrice` — цена яруса этой строки (первичный — каталог).
 */
export function serviceLinePrice(own, tierPrice) {
    return own === null || own === undefined ? tierPrice : own;
}
