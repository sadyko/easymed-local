// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — ЖИВЫЕ РАБОЧИЕ ЭКРАНЫ (браузер).
//
// Владелец: «whenever the invoice created or a patient sent show right away without
// the refresh». Сервер шлёт «записано» потоком /api/live (server/routes/live.js):
// версия, имена таблиц и RPC — без данных. Здесь:
//
//   • ОДИН поток на вкладку (EventSource), сколько бы экранов ни подписалось.
//     Обрыв — браузер переподключается сам; три ошибки подряд или закрытый поток —
//     переподключаемся мы, с нарастающей паузой (1 с … 60 с, с разбросом, чтобы
//     двадцать ПК клиники не ломились в сервер одновременно после его перезапуска);
//   • пока потока нет (EventSource недоступен, поток рвётся) — запасной опрос
//     /api/live/version раз в 15 с;
//   • onLive(predicate, handler) — подписка экрана; возвращает отписку. Обработчик
//     зовётся не на каждое событие, а раз в ~700 мс тишины (и не реже раза в 3 с при
//     непрерывном потоке) — с объединением пропущенного;
//   • скрытая вкладка (document.hidden) событий не исполняет: запоминает «есть
//     изменения» и срабатывает ОДИН раз, когда вкладку снова показали. Через 10 с
//     скрытости поток закрывается вовсе: у браузера 6 соединений на сервер на все
//     вкладки, и пять фоновых вкладок Easy-Med с открытыми потоками оставили бы
//     шестой на запросы экрана одно. Вкладка вернулась — поток открывается с номером
//     последней версии (?since=), и сервер сразу присылает пропущенное одним событием;
//   • сервер ответил 401 (сессии нет) — поток и опрос останавливаются до перезагрузки
//     страницы: стучаться без сессии бессмысленно, вход откроет страницу заново.
//
// watchScreen({ root, screen, reload }) — то, что зовёт рабочий экран: подписка по
// правилу экрана (live-relevance.js), тихое перечитывание его же обычной дорогой и
// ПРАВИЛО ЗАНЯТОСТИ: экран не перечитывается, пока человек что-то делает (открыто
// окно или выпадающий список, курсор в поле экрана, открыт мастер «Направить на
// услуги»), и пока его панель скрыта оболочкой. Изменение тогда откладывается и
// применяется, как только экран свободен (проверка раз в ~2 с). Экран вынули из
// документа — подписка снимается сама.
//
// Видимого текста у модуля нет: экран просто становится свежим — без мигания и
// без уведомлений.
import { liveRelevant } from './live-relevance.js';

export const LIVE_URL = '/api/live';
export const VERSION_URL = '/api/live/version';
export const POLL_MS = 15000;
export const DEBOUNCE_MS = 700;
export const MAX_WAIT_MS = 3000;
export const RECHECK_MS = 2000;
export const ALIVE_CHECK_MS = 30000;
export const HIDDEN_CLOSE_MS = 10000;
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 60000;
export const ES_GIVE_UP_ERRORS = 3;

const ES_CLOSED = 2;

const strings = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
function parse(text) {
    try { return JSON.parse(String(text)); } catch { return null; }
}

/**
 * Клиент потока. env — окружение (браузерные объекты по умолчанию; тесты дают свои):
 * { EventSource, fetch, document, window, setTimeout, clearTimeout, now, random }.
 */
export function createLiveClient(env = {}, opts = {}) {
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(env, k);
    const E = {
        EventSource: has('EventSource') ? env.EventSource : g.EventSource,
        fetch: has('fetch') ? env.fetch : (...a) => g.fetch(...a),
        document: has('document') ? env.document : g.document,
        window: has('window') ? env.window : g.window,
        // Под Node таймер не держит процесс (в браузере unref нет) — как у таймера кабинета.
        setTimeout: env.setTimeout || ((fn, ms) => {
            const t = g.setTimeout(fn, ms);
            if (t && typeof t.unref === 'function') t.unref();
            return t;
        }),
        clearTimeout: env.clearTimeout || ((h) => g.clearTimeout(h)),
        now: env.now || (() => Date.now()),
        random: env.random || Math.random,
    };
    const T = {
        pollMs: opts.pollMs ?? POLL_MS,
        debounceMs: opts.debounceMs ?? DEBOUNCE_MS,
        maxWaitMs: opts.maxWaitMs ?? MAX_WAIT_MS,
        recheckMs: opts.recheckMs ?? RECHECK_MS,
        aliveCheckMs: opts.aliveCheckMs ?? ALIVE_CHECK_MS,
        hiddenCloseMs: opts.hiddenCloseMs ?? HIDDEN_CLOSE_MS,
        backoffMin: opts.backoffMinMs ?? BACKOFF_MIN_MS,
        backoffMax: opts.backoffMaxMs ?? BACKOFF_MAX_MS,
        giveUp: opts.giveUpErrors ?? ES_GIVE_UP_ERRORS,
    };

    const subs = new Set();
    let es = null;
    let v = null;            // последняя известная версия
    let mode = 'off';        // off | connecting | sse | poll | paused | gone
    let errors = 0;          // ошибок потока подряд
    let reconnectTimer = null;
    let pollTimer = null;
    let hiddenTimer = null;
    let paused = false;      // вкладка давно скрыта — поток закрыт
    let gone = false;        // сессии нет — до перезагрузки страницы
    let wired = false;

    const hidden = () => { try { return !!(E.document && E.document.hidden); } catch { return false; } };

    // ---- доставка подписчикам ------------------------------------------------
    function merge(sub, change) {
        for (const t of change.tables) sub.acc.tables.add(t);
        for (const r of change.rpc) sub.acc.rpc.add(r);
        if (change.reset) sub.acc.reset = true;
    }
    function take(sub) {
        const out = { tables: [...sub.acc.tables].sort(), rpc: [...sub.acc.rpc].sort(), reset: sub.acc.reset };
        sub.acc = { tables: new Set(), rpc: new Set(), reset: false };
        return out;
    }
    function schedule(sub) {
        const now = E.now();
        if (!sub.firstAt) sub.firstAt = now;
        if (sub.timer) E.clearTimeout(sub.timer);
        const wait = Math.max(0, Math.min(sub.debounceMs, sub.firstAt + T.maxWaitMs - now));
        sub.timer = E.setTimeout(() => fire(sub), wait);
    }
    function fire(sub) {
        sub.timer = null;
        sub.firstAt = 0;
        if (!sub.active) return;
        if (hidden()) { sub.dirty = true; return; }
        const change = take(sub);
        try { sub.handler(change); } catch { /* экран сам скажет, если не смог */ }
    }
    function deliver(change) {
        for (const sub of [...subs]) {
            let hit = false;
            try { hit = !!sub.pred(change); } catch { hit = false; }
            if (!hit) continue;
            merge(sub, change);
            if (hidden()) { sub.dirty = true; continue; }
            schedule(sub);
        }
    }
    /** Событие сервера (поток или опрос): { v, tables, rpc, reset? }. */
    function apply(d) {
        if (!d || typeof d !== 'object') return;
        const nv = Number(d.v);
        if (!Number.isFinite(nv)) return;
        const change = { tables: strings(d.tables), rpc: strings(d.rpc), reset: d.reset === true };
        if (v == null) {
            v = nv;
            if (change.reset || change.tables.length || change.rpc.length) deliver(change);
            return;
        }
        if (!change.reset && nv <= v) return;   // повтор или старое
        // Новая версия без списка имён — что пропущено, не известно: считаем «всё».
        if (!change.reset && !Array.isArray(d.tables)) change.reset = true;
        const named = change.reset || change.tables.length > 0 || change.rpc.length > 0;
        v = nv;
        if (named) deliver(change);
    }

    // ---- поток -------------------------------------------------------------------
    function closeEs() {
        if (es) { try { es.close(); } catch { /* уже закрыт */ } }
        es = null;
    }
    function clearReconnect() { if (reconnectTimer) { E.clearTimeout(reconnectTimer); reconnectTimer = null; } }
    function scheduleReconnect() {
        if (reconnectTimer || gone || paused || !subs.size) return;
        const base = Math.min(T.backoffMax, T.backoffMin * 2 ** Math.max(0, errors - 1));
        const delay = Math.round(base * (0.8 + 0.4 * E.random()));
        reconnectTimer = E.setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    }
    function connect() {
        clearReconnect();
        if (gone || paused || !subs.size || es) return;
        if (typeof E.EventSource !== 'function') { mode = 'poll'; pollSoon(0); return; }
        let src;
        try {
            src = new E.EventSource(LIVE_URL + (v != null ? '?since=' + encodeURIComponent(v) : ''));
        } catch {
            errors++;
            mode = 'poll';
            pollSoon(T.pollMs);
            scheduleReconnect();
            return;
        }
        es = src;
        mode = 'connecting';
        src.onopen = () => {
            if (es !== src) return;
            errors = 0;
            mode = 'sse';
            stopPoll();
        };
        src.addEventListener('hello', (e) => {
            if (es !== src) return;
            const d = parse(e && e.data);
            if (d && v == null && Number.isFinite(Number(d.v))) v = Number(d.v);
        });
        src.addEventListener('change', (e) => {
            if (es !== src) return;
            apply(parse(e && e.data));
        });
        src.onerror = () => {
            if (es !== src) return;
            errors++;
            pollSoon(T.pollMs);   // пока потока нет — опрос
            if (src.readyState === ES_CLOSED || errors >= T.giveUp) {
                closeEs();
                mode = 'poll';
                scheduleReconnect();
            } else {
                mode = 'connecting';   // браузер переподключается сам
            }
        };
    }

    // ---- запасной опрос ---------------------------------------------------------
    function stopPoll() { if (pollTimer) { E.clearTimeout(pollTimer); pollTimer = null; } }
    function pollSoon(ms) {
        if (pollTimer || gone || paused || !subs.size) return;
        pollTimer = E.setTimeout(pollTick, ms);
    }
    async function pollTick() {
        pollTimer = null;
        if (gone || paused || !subs.size || mode === 'sse') return;
        try {
            const url = VERSION_URL + (v != null ? '?since=' + encodeURIComponent(v) : '');
            const res = await E.fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
            if (res && res.status === 401) { shutdown(); return; }
            if (res && res.ok) apply(await res.json());
        } catch { /* сеть моргнула — следующий опрос */ }
        if (mode !== 'sse') pollSoon(T.pollMs);
    }

    // ---- видимость вкладки и сессия ---------------------------------------------
    function pause() {
        paused = true;
        mode = 'paused';
        closeEs();
        stopPoll();
        clearReconnect();
    }
    function onVisibility() {
        if (gone) return;
        if (hidden()) {
            if (!hiddenTimer && !paused) {
                hiddenTimer = E.setTimeout(() => { hiddenTimer = null; if (hidden() && subs.size) pause(); }, T.hiddenCloseMs);
            }
            return;
        }
        if (hiddenTimer) { E.clearTimeout(hiddenTimer); hiddenTimer = null; }
        if (paused) { paused = false; mode = 'off'; connect(); }
        // Изменения, пришедшие, пока вкладка была скрыта, — один раз.
        for (const sub of subs) if (sub.dirty) { sub.dirty = false; schedule(sub); }
    }
    function shutdown() {
        gone = true;
        mode = 'gone';
        closeEs();
        stopPoll();
        clearReconnect();
        if (hiddenTimer) { E.clearTimeout(hiddenTimer); hiddenTimer = null; }
    }
    function wire() {
        if (wired) return;
        wired = true;
        try { if (E.document && typeof E.document.addEventListener === 'function') E.document.addEventListener('visibilitychange', onVisibility); } catch { /* без документа */ }
        // supabase.js: сервер ответил 401 «нет сессии» любому запросу вкладки.
        try { if (E.window && typeof E.window.addEventListener === 'function') E.window.addEventListener('easymed:session-gone', shutdown); } catch { /* без окна */ }
    }
    function start() {
        wire();
        if (gone) return;
        if (hidden()) { paused = true; mode = 'paused'; return; }
        connect();
    }
    function stopAll() {
        closeEs();
        stopPoll();
        clearReconnect();
        if (hiddenTimer) { E.clearTimeout(hiddenTimer); hiddenTimer = null; }
        paused = false;
        errors = 0;
        v = null;   // следующий экран начнёт с текущей версии, а не догонит чужое прошлое
        if (!gone) mode = 'off';
    }

    /**
     * Подписка: handler({ tables, rpc, reset }) — после ~debounceMs тишины, если
     * predicate(изменение) сказал «моё». Возвращает отписку.
     */
    function onLive(predicate, handler, { debounceMs } = {}) {
        if (typeof handler !== 'function') return () => {};
        const sub = {
            pred: typeof predicate === 'function' ? predicate : () => true,
            handler,
            debounceMs: Number.isFinite(debounceMs) ? debounceMs : T.debounceMs,
            acc: { tables: new Set(), rpc: new Set(), reset: false },
            timer: null, firstAt: 0, dirty: false, active: true,
        };
        subs.add(sub);
        if (subs.size === 1) start();
        return () => {
            if (!sub.active) return;
            sub.active = false;
            if (sub.timer) { E.clearTimeout(sub.timer); sub.timer = null; }
            subs.delete(sub);
            if (!subs.size) stopAll();
        };
    }

    return {
        onLive,
        status: () => ({ mode, v, subscribers: subs.size, open: !!es, errors }),
        recheckMs: T.recheckMs,
        aliveCheckMs: T.aliveCheckMs,
        setTimeout: E.setTimeout,
        clearTimeout: E.clearTimeout,
        document: () => E.document,
    };
}

// ---- один клиент на вкладку ------------------------------------------------------
// Только на настоящей странице (http/https). Экраны в тестах под Node рисуются в
// поддельном документе: там клиента нет, и экран просто не подписывается — ни опроса,
// ни таймеров, ни лишних запросов в чужие заглушки fetch. Тест живых экранов
// подставляет свой клиент (__setLiveClientForTests).
let shared;   // undefined — ещё не решено; null — живого обновления здесь нет
function realPage() {
    try {
        return typeof window !== 'undefined' && !!window && !!window.location
            && /^https?:$/.test(String(window.location.protocol || ''));
    } catch { return false; }
}
function liveClient() {
    if (shared === undefined) shared = realPage() ? createLiveClient() : null;
    return shared;
}
/** Подписка через общий клиент вкладки. Возвращает отписку. */
export function onLive(predicate, handler, opts) {
    const c = liveClient();
    return c ? c.onLive(predicate, handler, opts) : () => {};
}
/** Только для тестов: подменить общий клиент (null — выключить; undefined — решить заново). */
export function __setLiveClientForTests(client) { shared = client; }

// ---- правило занятости ------------------------------------------------------------
/**
 * Открытое окно: модальные окна приложения (.modal / .modal-backdrop), полноэкранный
 * мастер записи «Направить на услуги» (метка data-visit-wizard — правило 3.22.0
 * DIAG_ROUTE_V1 кабинета врача, теперь общее), раскрытые выпадающие списки и
 * календарь (ui-select.js, ui-datefield.js) и любое окно с aria-modal.
 */
export const BUSY_SELECTOR = '.modal-backdrop, .modal, [data-visit-wizard], .uisel-pop, .uidate-pop, [aria-modal="true"]';
export function dialogOpen(doc) {
    try {
        const d = doc || (typeof document !== 'undefined' ? document : null);
        if (!d || typeof d.querySelector !== 'function') return false;
        return !!d.querySelector(BUSY_SELECTOR);
    } catch { return false; }
}
// Поля, в которые не печатают: фокус на флажке после щелчка — не «человек занят».
const NOT_TYPING = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'range', 'color']);
/** Курсор в поле ввода ВНУТРИ экрана (input, select, textarea, contenteditable). */
export function editingInside(root, doc) {
    try {
        const d = doc || (typeof document !== 'undefined' ? document : null);
        const a = d && d.activeElement;
        if (!a || !root || a === root) return false;
        const tag = String(a.tagName || '').toUpperCase();
        const field = tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable === true
            || (tag === 'INPUT' && !NOT_TYPING.has(String(a.type || 'text').toLowerCase()));
        if (!field) return false;
        return typeof root.contains === 'function' ? !!root.contains(a) : false;
    } catch { return false; }
}
/** Человек что-то делает на этом экране — перечитывать нельзя. */
export function screenBusy(root, doc) { return dialogOpen(doc) || editingInside(root, doc); }
/** Панель экрана на экране: в документе и не скрыта оболочкой (display:none у неё или выше). */
export function shownOnScreen(root) {
    try {
        if (!root || root.isConnected === false) return false;
        if (typeof root.getClientRects === 'function') return root.getClientRects().length > 0;
        for (let n = root; n; n = n.parentNode || null) {
            if (n.style && n.style.display === 'none') return false;
        }
        return true;
    } catch { return true; }
}

/**
 * Рабочий экран подписывается на изменения, пока смонтирован.
 *   root     — корень экрана (вынут из документа — подписка снимается сама);
 *   screen   — ключ правила (live-relevance.js) или relevant — свой предикат;
 *   reload   — тихое перечитывание экрана ЕГО ЖЕ дорогой (фильтры, прокрутку,
 *              выбор и раскрытую строку оно обязано сохранять само);
 *   isBusy   — дополнительное правило занятости экрана (необязательно).
 * Возвращает stop().
 */
export function watchScreen({ root, screen, relevant, reload, isBusy, client } = {}) {
    const cl = client || liveClient();
    if (!cl || typeof reload !== 'function') return () => {};
    const pred = typeof relevant === 'function' ? relevant : liveRelevant(screen);
    let stopped = false;
    let pending = false;
    let running = false;
    let timer = null;
    let alive = null;
    let unsub = () => {};

    const doc = () => { try { return cl.document(); } catch { return null; } };
    const busy = () => {
        if (screenBusy(root, doc())) return true;
        try { return typeof isBusy === 'function' && !!isBusy(); } catch { return false; }
    };
    const stop = () => {
        if (stopped) return;
        stopped = true;
        unsub();
        if (timer) { cl.clearTimeout(timer); timer = null; }
        if (alive) { cl.clearTimeout(alive); alive = null; }
    };
    const arm = () => {
        if (timer || stopped) return;
        timer = cl.setTimeout(() => { timer = null; attempt(); }, cl.recheckMs);
    };
    function attempt() {
        if (stopped) return;
        if (!root || root.isConnected === false) { stop(); return; }
        if (running || !pending) return;
        if (!shownOnScreen(root) || busy()) { arm(); return; }
        pending = false;
        running = true;
        Promise.resolve()
            .then(() => reload())
            .catch(() => { /* сеть моргнула — следующее изменение перечитает */ })
            .then(() => { running = false; if (pending) attempt(); });
    }
    // Экран вынули, а изменений нет — подписка всё равно снимается (поток не держится зря).
    const checkAlive = () => {
        alive = null;
        if (stopped) return;
        if (!root || root.isConnected === false) { stop(); return; }
        alive = cl.setTimeout(checkAlive, cl.aliveCheckMs);
    };
    unsub = cl.onLive(pred, () => { pending = true; attempt(); });
    alive = cl.setTimeout(checkAlive, cl.aliveCheckMs);
    return stop;
}
