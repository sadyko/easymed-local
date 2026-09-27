// V3120_FINAL (I5) — «ЗАПРОС ОТ ЧЕЛОВЕКА ИЛИ ОТ ЭКРАНА САМОГО?»
//
// Сервер закрывает сессию после SESSION_IDLE_HOURS без работы
// (server/services/auth.js). Но экраны опрашивают сервер сами: счётчики меню
// каждые 20 секунд, табло очереди, непрочитанные Telegram, телефония,
// автообновление. Каждый такой опрос продлевал сессию, и компьютер у стойки,
// оставленный открытым, не выходил никогда.
//
// Помечать каждый опрос вручную ненадёжно (цепочки вызовов длинные, новый
// опрос забудут пометить). Поэтому правило одно, на уровне отправки запроса:
// если человек ничего не нажимал, не печатал и не двигал мышью последние
// ACTIVE_WINDOW_MS, запрос — фоновый и уходит с заголовком
// x-em-background: 1; сервер такой запрос проверяет, но сессию им не
// продлевает. Любое действие человека (клик → запрос) идёт в пределах
// миллисекунд после события ввода и продлевает сессию как раньше.
export const BACKGROUND_HEADER = 'x-em-background';
export const ACTIVE_WINDOW_MS = 60 * 1000;

let lastInput = Date.now();   // открытие страницы — тоже действие человека

export function noteUserInput(at = Date.now()) { lastInput = at; }

export function isBackgroundNow(now = Date.now()) { return now - lastInput > ACTIVE_WINDOW_MS; }

/** Заголовки запроса + пометка фона, если человек сейчас ничего не делает. */
export function withActivityHeaders(headers, now = Date.now()) {
    const out = { ...(headers || {}) };
    if (isBackgroundNow(now)) out[BACKGROUND_HEADER] = '1';
    return out;
}

if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
    const mark = () => { lastInput = Date.now(); };
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'input', 'focus']) {
        try { window.addEventListener(ev, mark, { capture: true, passive: true }); } catch { /* старый браузер */ }
    }
}
