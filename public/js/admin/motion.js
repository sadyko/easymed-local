// MOTION_REVEAL_V1 (2026-09-05) — общий помощник движения.
// docs/plans/2026-09-05-ui-redesign-and-calendar.md, задача 8:
// «IntersectionObserver для появления карточек и строк таблиц (ОДИН общий
// помощник, а не по копии на экран), плавная прокрутка к якорям, переходы
// вкладок. Всё — под prefers-reduced-motion».
//
// СЛОВАРЬ ДВИЖЕНИЯ ЗДЕСЬ НЕ ЗАВОДИТСЯ. Длительности и кривые объявлены один
// раз в admin.css (MOTION_TOKENS_V1: --dur-1/2/3, --ease-out/-in-out/-spring),
// и всё, что этому файлу нужно в миллисекундах, он ЧИТАЕТ оттуда (durMs).
// Литеральных «140ms» в коде нет намеренно: второй словарь разошёлся бы с
// первым в первый же месяц.
//
// ГЛАВНОЕ РЕШЕНИЕ ФАЙЛА — КАК ОН ЛОМАЕТСЯ.
// Помощник появления скрывает элементы и показывает их обратно. Значит его
// отказ — это НЕ «нет анимации», а «пустая страница»: класс с opacity: 0
// остался, а показать его некому. Поэтому прятать умеет ровно тот, кто уже
// доказал, что умеет показать:
//   * нет IntersectionObserver (киоски, старый WebView) — не прячем вовсе;
//   * prefers-reduced-motion: reduce — не прячем вовсе;
//   * наблюдатель создан, но за отведённое время не сказал НИ РАЗУ (в живом
//     браузере он отвечает сразу после observe()) — показываем всё сами;
//   * помощника сняли (disconnect) — показываем всё, что осталось скрытым.
// Отказ обязан читаться как «видно, но без анимации».
//
// ЧТО НЕ АНИМИРУЕТСЯ — тоже решение:
//   * содержимое диалогов: появление самого диалога уже переход, второй слой
//     внутри него читается как подвисание;
//   * заголовки таблиц (thead): шапка не «прибывает», она рамка экрана;
//   * печатные шаблоны: их размеры выверены физически, туда не ходим.

// ---------------------------------------------------------------------------
// Классы. Скрывающий класс ставит ТОЛЬКО этот файл и только когда уверен, что
// снимет его: в разметке его быть не должно (иначе выключенный JS = белый
// экран). Правила — admin.css, секция MOTION_REVEAL_V1.
// ---------------------------------------------------------------------------
export const HIDDEN_CLASS = 'reveal-init';
export const SHOWN_CLASS = 'reveal-in';
export const FLAT_CLASS = 'reveal-flat';

// Диалог и его карточка. Внутри — не наблюдаем (см. шапку файла).
const MODAL_SELECTOR = '.modal, .modal-card, [role="dialog"]';
const MODAL_CLASSES = ['modal', 'modal-card'];

// Наблюдатель в живом браузере отвечает первым вызовом сразу после observe().
// Если за это время он не сказал ничего — считаем его сломанным и показываем
// всё. Это не длительность анимации, а сторожевой таймер, поэтому он и не
// токен: токены измеряют то, что видит глаз.
const FAILSAFE_MS = 1200;

// Один помощник на корень: повторный вызов для того же контейнера снимает
// предыдущий. Списки перерисовываются (поиск, страница, опрос), и без этого
// на экране копились бы наблюдатели за строками, которых уже нет.
const byRoot = typeof WeakMap === 'function' ? new WeakMap() : null;

// ---------------------------------------------------------------------------
// Мелочи, которые обязаны работать и в браузере, и на поддельном DOM тестов.
// ---------------------------------------------------------------------------
function addClass(el, cls) {
    if (!el || !cls) return;
    if (el.classList && typeof el.classList.add === 'function') { el.classList.add(cls); return; }
    const has = String(el.className || '').split(/\s+/).includes(cls);
    if (!has) el.className = (el.className ? el.className + ' ' : '') + cls;
}

function removeClass(el, cls) {
    if (!el || !cls) return;
    if (el.classList && typeof el.classList.remove === 'function') { el.classList.remove(cls); }
    el.className = String(el.className || '')
        .split(/\s+/).filter((c) => c && c !== cls).join(' ');
}

function hasClass(el, cls) {
    return !!el && String(el.className || '').split(/\s+/).includes(cls);
}

/** Уважает ли пользователь-настройка «меньше движения». Нет matchMedia — нет и просьбы. */
export function prefersReducedMotion() {
    try {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        return !!(mq && mq.matches);
    } catch (e) {
        return false;
    }
}

/**
 * Длительность из ТОКЕНА admin.css в миллисекундах: durMs('--dur-2').
 * Второго словаря длительностей в приложении нет — есть этот перевод.
 */
export function durMs(token, fallback = 140) {
    try {
        if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
        const root = document.documentElement;
        if (!root) return fallback;
        const raw = String(getComputedStyle(root).getPropertyValue(token) || '').trim();
        if (!raw) return fallback;
        const n = parseFloat(raw);
        if (!isFinite(n)) return fallback;
        return /ms$/.test(raw) ? n : n * 1000;   // и «0.22s» тоже читается
    } catch (e) {
        return fallback;
    }
}

/** Кривая из токена admin.css; неизвестная — линейный запас, а не падение. */
export function easing(token, fallback = 'cubic-bezier(0.2, 0.7, 0.3, 1)') {
    try {
        if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
        const root = document.documentElement;
        if (!root) return fallback;
        const raw = String(getComputedStyle(root).getPropertyValue(token) || '').trim();
        return raw || fallback;
    } catch (e) {
        return fallback;
    }
}

function insideModal(el) {
    try {
        if (el && typeof el.closest === 'function') return !!el.closest(MODAL_SELECTOR);
    } catch (e) { /* поддельный DOM без closest — идём пешком */ }
    let n = el && el.parentNode;
    let guard = 0;
    while (n && guard++ < 200) {
        const cls = String(n.className || '');
        if (cls) {
            const parts = cls.split(/\s+/);
            for (const m of MODAL_CLASSES) if (parts.includes(m)) return true;
        }
        if (n.getAttribute && n.getAttribute('role') === 'dialog') return true;
        n = n.parentNode;
    }
    return false;
}

function insideTableHead(el) {
    let n = el;
    let guard = 0;
    while (n && guard++ < 200) {
        const tag = String(n.tagName || '').toUpperCase();
        if (tag === 'THEAD') return true;
        if (tag === 'TABLE' || tag === 'BODY') return false;
        n = n.parentNode;
    }
    return false;
}

function collect(root, selector) {
    let list = [];
    try {
        if (root && typeof root.querySelectorAll === 'function') {
            list = Array.from(root.querySelectorAll(selector) || []);
        }
    } catch (e) {
        list = [];
    }
    // Дети корня напрямую — на поддельном DOM (и на корне без querySelectorAll)
    // это единственный путь; в браузере querySelectorAll уже всё нашёл.
    if (!list.length && root && Array.isArray(root.children)) {
        list = root.children.filter((c) => c && c.nodeType !== 3);
    }
    return list.filter((el) => el && !insideModal(el) && !insideTableHead(el));
}

const NOOP_CONTROLLER = () => ({
    observed: 0, revealed: 0, observer: null, mode: 'immediate',
    disconnect() {},
});

/**
 * Показать содержимое по мере прокрутки.
 *
 * @param {Element}  root          контейнер (tbody, сетка карточек, ряд плиток)
 * @param {string}   [selector]    что внутри него появляется
 * @param {object}   [opts]
 * @param {boolean}  [opts.lift]   с подъёмом (карточки) или только прозрачность
 *                                 (строки таблицы: transform на <tr> у части
 *                                 браузеров дрожит на подпиксельной сетке)
 * @param {Function} [opts.observerFactory] только для тестов
 * @returns {{observed:number, revealed:number, observer:object|null, mode:string, disconnect:Function}}
 *
 * Договор:
 *   * НА ВЕСЬ КОРЕНЬ — ОДИН наблюдатель, сколько бы строк в нём ни было;
 *   * элемент, который показали, снимается с наблюдения тут же;
 *   * повторный вызов для того же корня снимает предыдущий помощник;
 *   * при reduce-motion и без IntersectionObserver наблюдателя нет ВОВСЕ,
 *     а содержимое видно сразу;
 *   * ни один путь выхода не оставляет элемент прозрачным.
 */
export function revealOn(root, selector = '[data-reveal]', opts = {}) {
    const { lift = true, threshold = 0.02, rootMargin = '0px 0px -6% 0px', observerFactory = null } = opts;
    if (!root) return NOOP_CONTROLLER();

    // Прошлый помощник этого корня уходит вместе со своей разметкой.
    if (byRoot && byRoot.has(root)) {
        try { byRoot.get(root).disconnect(); } catch (e) { /* уже ушёл */ }
        byRoot.delete(root);
    }

    const items = collect(root, selector);
    if (!items.length) return NOOP_CONTROLLER();

    const IO = observerFactory
        || (typeof IntersectionObserver === 'function' ? (cb, o) => new IntersectionObserver(cb, o) : null);

    // ── Путь «видно, но без анимации». Ничего не прячем — значит нечего и
    // разблокировать: страница выглядит ровно так же, как без этого файла.
    if (!IO || prefersReducedMotion()) {
        for (const el of items) { removeClass(el, HIDDEN_CLASS); removeClass(el, FLAT_CLASS); }
        return { observed: 0, revealed: items.length, observer: null, mode: 'immediate', disconnect() {} };
    }

    for (const el of items) {
        addClass(el, HIDDEN_CLASS);
        if (!lift) addClass(el, FLAT_CLASS);
    }

    const pending = [];
    const hidden = new Set(items);
    let heard = false;
    let flushScheduled = false;
    let failsafe = null;
    let observer = null;
    let dead = false;

    // Шаг лесенки — самая короткая ступень словаря. Ступеней не больше
    // четырёх: на пятисотстрочной таблице «каждой строке своя задержка»
    // превратилась бы в минуту ожидания последней.
    const step = durMs('--dur-1', 80);
    const MAX_STEPS = 4;
    const timers = new Set();

    // ПОСЛЕ появления от помощника не остаётся НИЧЕГО: оба класса снимаются.
    // Это не уборка ради чистоты — .reveal-in задаёт transform: none, и
    // забытый на карточке класс отменил бы её собственный подъём при
    // наведении, а .reveal-init навязал бы ей чужую длительность перехода.
    function settle(el) {
        removeClass(el, SHOWN_CLASS);
        removeClass(el, HIDDEN_CLASS);
        removeClass(el, FLAT_CLASS);
        if (el && el.style) el.style.transitionDelay = '';
    }

    function show(el, order) {
        if (!hidden.has(el)) return;
        hidden.delete(el);
        const delay = order > 0 ? Math.min(order, MAX_STEPS) * step : 0;
        if (delay && el.style) el.style.transitionDelay = delay + 'ms';
        addClass(el, SHOWN_CLASS);
        return delay;
    }

    // Показываем пачкой в одном кадре: пятьсот строк, входящих в экран
    // одновременно, не должны стать пятьюстами отдельными правками стиля.
    function flush() {
        flushScheduled = false;
        const batch = pending.splice(0, pending.length);
        if (!batch.length) return;
        for (let i = 0; i < batch.length; i++) show(batch[i], i);
        // Один таймер уборки на ПАЧКУ, а не на элемент: пятьсот строк не
        // должны стать пятьюстами таймерами.
        if (typeof setTimeout === 'function') {
            const life = durMs('--dur-3', 220) + MAX_STEPS * step + step;
            const tm = setTimeout(() => {
                timers.delete(tm);
                for (const el of batch) settle(el);
            }, life);
            timers.add(tm);
        }
    }

    function scheduleFlush() {
        if (flushScheduled) return;
        flushScheduled = true;
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
        else flush();
    }

    function revealEverything() {
        for (const el of Array.from(hidden)) show(el, 0);
        pending.length = 0;
    }

    function onEntries(entries) {
        heard = true;
        for (const entry of entries || []) {
            if (!entry || !entry.isIntersecting) continue;
            const el = entry.target;
            // Показанное снимается с наблюдения сразу: наблюдатель живёт
            // ровно столько, сколько в нём есть смысл.
            try { observer && observer.unobserve(el); } catch (e) { /* ушёл из документа */ }
            if (hidden.has(el)) pending.push(el);
        }
        if (pending.length) scheduleFlush();
    }

    try {
        observer = IO(onEntries, { threshold, rootMargin });
        for (const el of items) observer.observe(el);
    } catch (e) {
        // Наблюдатель есть, но отказал. Значит показать некому — показываем сами.
        revealEverything();
        return { observed: 0, revealed: items.length, observer: null, mode: 'immediate', disconnect() {} };
    }

    if (typeof setTimeout === 'function') {
        failsafe = setTimeout(() => {
            if (heard || dead) return;   // ответил хоть раз — значит работает
            revealEverything();
            try { observer.disconnect(); } catch (e) { /* всё равно уходим */ }
        }, FAILSAFE_MS);
    }

    const controller = {
        observed: items.length,
        revealed: 0,
        observer,
        mode: 'observed',
        get pendingCount() { return hidden.size; },
        disconnect() {
            dead = true;
            if (typeof clearTimeout === 'function') {
                if (failsafe) clearTimeout(failsafe);
                for (const tm of timers) clearTimeout(tm);
            }
            timers.clear();
            failsafe = null;
            try { observer.disconnect(); } catch (e) { /* уже */ }
            // Экран снимают — скрытое обязано стать видимым, а не уехать в
            // кэш панелей прозрачным. Уборка здесь немедленная: анимировать
            // уже нечего, важно только то, что видно.
            revealEverything();
            for (const el of items) settle(el);
            if (byRoot && byRoot.get(root) === controller) byRoot.delete(root);
        },
    };
    if (byRoot) byRoot.set(root, controller);
    return controller;
}

/** Снять помощника с корня (перерисовка, размонтирование панели). */
export function stopReveal(root) {
    if (!byRoot || !root || !byRoot.has(root)) return false;
    try { byRoot.get(root).disconnect(); } catch (e) { /* уже */ }
    byRoot.delete(root);
    return true;
}

/**
 * Пометить элементы к появлению: одна строка на экране вместо повторения
 * 'data-reveal' в каждой ветке разметки.
 */
export function markReveal(el) {
    if (el && typeof el.setAttribute === 'function') el.setAttribute('data-reveal', '');
    return el;
}

// ---------------------------------------------------------------------------
// Прокрутка к якорю. Приложение прыгает — пусть едет; но «меньше движения»
// значит и «не вози экран», поэтому просьба уважается и здесь.
// ---------------------------------------------------------------------------
export function smoothScrollTo(target, { block = 'start', inline = 'nearest' } = {}) {
    if (!target) return false;
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    try {
        if (typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ behavior, block, inline });
            return true;
        }
    } catch (e) { /* старый scrollIntoView без словаря аргументов */ }
    try { target.scrollIntoView(true); return true; } catch (e) { return false; }
}

/** Вернуть прокручиваемый контейнер (или окно) в начало — тоже под просьбу. */
export function smoothScrollToTop(container) {
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    const el = container || (typeof window !== 'undefined' ? window : null);
    if (!el) return false;
    try {
        if (typeof el.scrollTo === 'function') { el.scrollTo({ top: 0, behavior }); return true; }
    } catch (e) { /* без словаря аргументов */ }
    try { el.scrollTop = 0; return true; } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// Короткие переходы на месте. Всё через Web Animations API и все — с проверкой:
// нет el.animate (поддельный DOM тестов, древний браузер) — просто ничего не
// происходит, и НИЧЕГО при этом не остаётся спрятанным.
// ---------------------------------------------------------------------------
function canAnimate(el) {
    return !!el && typeof el.animate === 'function' && !prefersReducedMotion();
}

/** Появление панели вкладки: прозрачность и короткий подъём, без сдвига соседей. */
export function animateIn(el, { distance = 4, token = '--dur-2' } = {}) {
    if (!canAnimate(el)) return null;
    try {
        return el.animate(
            [{ opacity: 0, transform: 'translateY(' + distance + 'px)' }, { opacity: 1, transform: 'none' }],
            { duration: durMs(token, 140), easing: easing('--ease-out') },
        );
    } catch (e) {
        return null;
    }
}

/**
 * Смена состояния, которая меняет РАЗМЕР (сворачивание колонки меню).
 * Ширину не анимируем принципиально: анимация грид-колонки — это перерасчёт
 * всей страницы на каждый кадр, и на клиничеcком компьютере это видно. Вместо
 * этого коротко гасим и возвращаем прозрачность: смена читается как
 * намеренная, а раскладка перещёлкивается один раз.
 */
export function pulseFade(el, { from = 0.4, token = '--dur-2' } = {}) {
    if (!canAnimate(el)) return null;
    try {
        return el.animate([{ opacity: from }, { opacity: 1 }],
            { duration: durMs(token, 140), easing: easing('--ease-out') });
    } catch (e) {
        return null;
    }
}

/**
 * Закрыть наложение с угасанием и убрать из документа.
 * Убрать обязано ЛЮБОЙ ценой: закрытие — это не украшение, а действие
 * пользователя. Нет анимации — убираем немедленно, той же строкой.
 */
export function fadeOutAndRemove(el, done) {
    const finish = () => {
        try { if (el && typeof el.remove === 'function') el.remove(); } catch (e) { /* уже нет */ }
        if (typeof done === 'function') done();
    };
    if (!canAnimate(el)) { finish(); return null; }
    let anim = null;
    try {
        anim = el.animate([{ opacity: 1 }, { opacity: 0 }],
            { duration: durMs('--dur-2', 140), easing: easing('--ease-out'), fill: 'forwards' });
    } catch (e) {
        finish();
        return null;
    }
    let closed = false;
    const once = () => { if (closed) return; closed = true; finish(); };
    anim.onfinish = once;
    anim.oncancel = once;
    // Страховка: вкладка в фоне может не довести анимацию до конца, а окно
    // обязано закрыться.
    if (typeof setTimeout === 'function') setTimeout(once, durMs('--dur-2', 140) + FAILSAFE_MS);
    return anim;
}
