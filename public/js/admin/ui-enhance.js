// UI_ENHANCE_V1 (2026-09-05) — ОДНА ТОЧКА, ГДЕ РОДНЫЕ ПОЛЯ СТАНОВЯТСЯ ПОЛЯМИ
// ПРОГРАММЫ.
//
// Владелец: «please fix the dialogue windows and dropdowns and calendar
// pickers design. its the default dropdowns. not a system design dropdowns».
//
// Списков в программе больше полутора сотен, полей даты — полсотни, и они
// разбросаны по ста пяти видам. Переписывать места вызова — это сто пятьдесят
// правок, каждая со своей возможностью ошибиться, и ни одной гарантии, что
// следующий экран не заведёт сто пятьдесят первый родной <select>.
//
// Поэтому обновление идёт НАБЛЮДЕНИЕМ, а не правкой: один наблюдатель следит
// за документом и обновляет всё, что появилось, — включая содержимое
// диалоговых окон, которые дорисовываются в <body> мимо корня вида.
//
// ОТКАЗ РАБОТАЕТ БЕЗ ПРАВОК: элемент с data-no-enhance (или лежащий внутри
// такого) остаётся родным. Это дверь для случаев, где родное поле нужнее
// красивого — например, если печатный бланк когда-нибудь начнут собирать из
// живой формы.
//
// НИЧЕГО НЕ ЛОМАЕТСЯ, ЕСЛИ ЭТОТ ФАЙЛ ВЫКЛЮЧИТЬ. Родные поля остаются в
// разметке и остаются источником правды: программа продолжит работать ровно
// как прежде, просто со списками операционной системы.

import { enhanceSelectsIn } from './ui-select.js?v=uisel1';
import { enhanceDateFieldsIn } from './ui-datefield.js?v=uidate1';

let started = false;
let queued = false;
let observer = null;

/** Обновляет всё внутри узла. Возвращает {selects, dates} — сколько обёрнуто. */
export function enhanceIn(root) {
    if (!root) return { selects: 0, dates: 0 };
    let selects = 0, dates = 0;
    try { selects = enhanceSelectsIn(root); } catch (e) { console.warn('[ui-enhance] select:', e && e.message); }
    try { dates = enhanceDateFieldsIn(root); } catch (e) { console.warn('[ui-enhance] date:', e && e.message); }
    return { selects, dates };
}

// Пачкой в конце кадра: перерисовка экрана добавляет узлы сотнями, и обход на
// каждое добавление стоил бы дороже самой перерисовки.
function schedule() {
    if (queued) return;
    queued = true;
    const run = () => { queued = false; enhanceIn(document.body); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
}

/**
 * Включает обновление на весь документ. Вызывается один раз при запуске
 * оболочки; повторный вызов ничего не делает.
 */
export function startUiEnhance() {
    if (started || typeof document === 'undefined') return false;
    started = true;
    enhanceIn(document.body);
    if (typeof MutationObserver !== 'function') return true;   // старый браузер — просто без наблюдения
    observer = new MutationObserver((records) => {
        for (const r of records) {
            if (r.addedNodes && r.addedNodes.length) { schedule(); return; }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return true;
}

export function stopUiEnhance() {
    if (observer) { observer.disconnect(); observer = null; }
    started = false; queued = false;
}
