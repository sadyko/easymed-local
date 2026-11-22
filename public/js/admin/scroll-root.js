// SCROLL_IN_CONTENT_V1 (2026-11-21) — где живёт прокрутка экрана.
//
// Страница больше не прокручивается: прокручивается область содержимого
// (.app > .main, admin-views.css SCROLL_IN_CONTENT_V1), а верхняя полоса и
// колонка стоят на месте. Код, который запоминал и возвращал window.scrollY
// (возврат на экран, тихие перерисовки списков), спрашивает позицию здесь.
//
// Нет оболочки (поддельный DOM тестов, отдельное окно печати) — падаем
// обратно на окно, как было раньше.

export function scrollRoot() {
    try {
        const el = typeof document !== 'undefined' && document.querySelector ? document.querySelector('.app > .main') : null;
        return el && typeof el.scrollTop === 'number' ? el : null;
    } catch (_) { return null; }
}

export function getScrollTop() {
    const el = scrollRoot();
    if (el) return el.scrollTop || 0;
    if (typeof window === 'undefined') return 0;
    return Number(window.scrollY) || (typeof document !== 'undefined' && document.documentElement && document.documentElement.scrollTop) || 0;
}

/** Мгновенно (не плавно — это восстановление, а не переход). */
export function setScrollTop(top) {
    const y = Number(top) || 0;
    const el = scrollRoot();
    if (el) {
        try { el.scrollTo({ top: y, behavior: 'instant' }); return; } catch (_) { /* старый браузер */ }
        try { el.scrollTop = y; } catch (_) { /* элемент ушёл */ }
        return;
    }
    if (typeof window === 'undefined' || typeof window.scrollTo !== 'function') return;
    try { window.scrollTo({ top: y, behavior: 'instant' }); } catch (_) { window.scrollTo(0, y); }
}
