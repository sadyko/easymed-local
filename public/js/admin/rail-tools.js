// RAIL_TOOLS_V1 (2026-11-21) — экран отдаёт свои кнопки в левую колонку.
//
// Владелец, со снимком CRM: «on a left side no need to put CRM again better put
// this all to the left side bar, and remove it from here and we save space».
// В отделе «CRM» колонка показывала один пункт «CRM · Заявки», а все кнопки
// раздела (Доска, Мои задачи, Мой KPI, Cust Dev, Дубликаты, Отчёт, Excel,
// Информация) стояли в тёмном баннере экрана. Теперь экран регистрирует их
// здесь, и колонка (admin.js renderSidebar) рисует их ВМЕСТО своего пункта,
// пока этот пункт открыт.
//
// Почему реестр, а не прямой вызов admin.js: экран не знает о колонке, а
// колонка — о замыканиях экрана (отчёт, выгрузка живут внутри отрисовки CRM).
// Регистрация хранится по ключу пункта и переживает уход с экрана: панель CRM
// кэшируется (VIEW_CACHE_MAX), и при возврате без перерисовки кнопки обязаны
// остаться те же. Вне оболочки (стенды тестов) слушателя нет — регистрация
// просто лежит, и тест достаёт кнопки через railToolsFor().

const registry = new Map();   // owner (id пункта меню) -> () => Array<Array<Node>>
let listener = null;

/**
 * @param {string} owner  id пункта меню, вместо которого рисуются кнопки
 * @param {() => Array<Array<Node>>} build  группы кнопок; между группами колонка ставит черту
 */
export function setRailTools(owner, build) {
    registry.set(owner, build);
    if (listener) { try { listener(owner); } catch (e) { console.warn('[rail-tools]', e); } }
}

export function railToolsFor(owner) {
    return registry.get(owner) || null;
}

/** Только оболочка: один слушатель на страницу. */
export function onRailToolsChange(fn) {
    listener = typeof fn === 'function' ? fn : null;
}
