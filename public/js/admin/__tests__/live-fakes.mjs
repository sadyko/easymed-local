// LIVE_REFRESH_V1 (3.22.0) — подделки для тестов живых экранов: часы, EventSource,
// документ. Не тестовый файл — его импортируют live.test.mjs и live-screens.test.mjs.

/** Ручные часы: setTimeout/clearTimeout и advance(ms), исполняющий созревшие задачи. */
export function fakeClock(start = 1_000_000) {
    let now = start;
    let seq = 0;
    const tasks = new Map();
    const clock = {
        now: () => now,
        setTimeout(fn, ms) { const id = ++seq; tasks.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, id }); return id; },
        clearTimeout(id) { tasks.delete(id); },
        pending: () => tasks.size,
        /** Сдвинуть время на ms, исполняя задачи по порядку; между задачами — микрозадачи. */
        async advance(ms) {
            const until = now + ms;
            for (;;) {
                await flush();
                let next = null;
                for (const t of tasks.values()) if (t.at <= until && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
                if (!next) break;
                tasks.delete(next.id);
                now = next.at;
                next.fn();
            }
            now = until;
            await flush();
        },
    };
    return clock;
}
export async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

/** EventSource-подделка: открытые экземпляры — FakeES.all. */
export class FakeES {
    constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        this.closed = false;
        this.onopen = null;
        this.onerror = null;
        this._l = {};
        FakeES.all.push(this);
    }
    addEventListener(type, fn) { (this._l[type] || (this._l[type] = [])).push(fn); }
    close() { this.readyState = 2; this.closed = true; }
    // ---- управление из теста ----
    open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
    emit(type, data) { for (const fn of this._l[type] || []) fn({ type, data: JSON.stringify(data) }); }
    fail(closed = false) { this.readyState = closed ? 2 : 0; if (this.onerror) this.onerror({}); }
    static reset() { FakeES.all = []; }
    static live() { return FakeES.all.filter((e) => !e.closed); }
}
FakeES.all = [];

/** Документ-подделка: hidden, visibilitychange, querySelector для окон, activeElement. */
export function fakeDocument() {
    const listeners = {};
    const doc = {
        hidden: false,
        activeElement: null,
        modal: false,
        addEventListener(t, fn) { (listeners[t] || (listeners[t] = [])).push(fn); },
        removeEventListener() {},
        querySelector(sel) { return doc.modal && /\.modal/.test(sel) ? { className: 'modal' } : null; },
        setHidden(h) { doc.hidden = h; for (const fn of listeners.visibilitychange || []) fn({}); },
    };
    return doc;
}
