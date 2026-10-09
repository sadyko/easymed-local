// CLINIC_API_FIX_V1 (ревью 5) — ОДНО ПРАВИЛО ЦЕН ВТОРОГО И ПОВТОРНОГО ВИЗИТА
// для окна услуги (server/services/rpc/service-save.js) и импорта из Excel
// (public/js/admin/views/section-import-export.js, visitTierProblem). Модуль
// чистый: без перевода и без DOM — сервер его импортирует так же, как
// shared/specialty-list.js. Возвращает РУССКУЮ фразу (ключ словаря) или null;
// экран переводит её tr(), сервер отдаёт её как есть.
//
// Как касса считает цену (server/services/domain/visit-tier.js):
//   • второй визит (прошлый — первичный) — окно второго визита [«со дня» (пусто
//     — 1) … «по день» (пусто — без предела)]; цена — второго визита, а если её
//     нет — повторного;
//   • повторный визит (третий и далее) — своё окно, если задана хоть одна его
//     граница, иначе окно второго; цена — повторного, а если её нет — второго.
//
// Отсюда две ловушки, которые правило закрывает:
//   • цена повторного визита без цены второго и без «по день» второго — она
//     действует СО ВТОРОГО визита без срока (через год — тоже скидка). Так
//     случалось, когда снимали ступень второго визита, а повторная оставалась;
//   • своё окно повторного визита с «не раньше», но без «не позже» — повторная
//     цена без срока, хотя подсказка обещала «как у второго». Исключение —
//     второй визит сам «без предела» по выбору (цена задана, «по день» пусто):
//     тогда повторный следует тому же выбору.
// Цена второго визита, заданная без «по день», — «без предела» по подсказке
// («пусто — без предела»): это осознанный выбор одной ступени, не ошибка.

export const VISIT_TIER_MESSAGES = {
    secondReversed: 'Окно второго визита: «по день» не может быть раньше «со дня».',
    secondNoPrice: 'Укажите цену второго визита — иначе окно дней не на что применить.',
    repeatReversed: 'Окно повторного визита: «не позже чем через» не может быть раньше «не раньше чем через».',
    repeatNoPrice: 'Укажите цену повторного визита — иначе окно дней не на что применить.',
    repeatWithoutSecond: 'Цена повторного визита без цены второго визита действовала бы со второго визита без срока — задайте цену второго визита или его «по день».',
    repeatOpenEnded: 'Окно повторного визита задано без «не позже чем через» — цена повторного визита действовала бы без срока. Задайте «не позже чем через» или очистите окно повторного визита.',
};

const n = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/**
 * Причина (русская фраза) или null. `t` — шесть полей так, как они окажутся у
 * услуги: price_secondary, secondary_days_from, secondary_days_to, price_repeat,
 * repeat_days_from, repeat_days_to (null / пусто — не задано). Числа уже
 * проверены вызывающим (неотрицательные цены, целые дни).
 */
export function visitTierStateProblem(t) {
    const sp = n(t.price_secondary), rp = n(t.price_repeat);
    const sf = n(t.secondary_days_from), st = n(t.secondary_days_to);
    const rf = n(t.repeat_days_from), rt = n(t.repeat_days_to);
    const M = VISIT_TIER_MESSAGES;
    if (sf !== null && st !== null && st < sf) return M.secondReversed;
    if ((sf !== null || st !== null) && sp === null && rp === null) return M.secondNoPrice;
    if (rf !== null && rt !== null && rt < rf) return M.repeatReversed;
    if ((rf !== null || rt !== null) && sp === null && rp === null) return M.repeatNoPrice;
    if (rp !== null && sp === null && st === null) return M.repeatWithoutSecond;
    // Повторному визиту достаётся цена повторного, а без неё — второго.
    const secondOpenByChoice = sp !== null && st === null;
    if ((rp ?? sp) !== null && (rf !== null || rt !== null) && rt === null && !secondOpenByChoice) return M.repeatOpenEnded;
    return null;
}
