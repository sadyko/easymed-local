// CALL_RING_V1 (2026-10-17) — РЕШЕНИЯ БЛОКА «ЗВОНИТ» БЕЗ DOM.
//
// Какой из живых звонков показать, как его назвать, когда пискнуть и чем.
// Часы, выбор трубки и состояние «звук выключен» приходят параметрами; звук —
// короткий двойной сигнал WebAudio (осциллятор: ни файлов, ни сети, которых у
// клиники без интернета может не быть). Всё проверяется в crm-ring-logic.test.js.
import { formatPhone } from './phone-format.js';

/** Сигнал не чаще раза в две секунды и не дольше 40 секунд с начала звонка. */
export const BEEP_EVERY_MS = 2000;
export const BEEP_MAX_MS = 40_000;

const LIVE_STATES = new Set(['ringing', 'answered', 'ended']);

/**
 * Что показывать: самый свежий ВХОДЯЩИЙ звонок, который звонит, идёт или только
 * что сорвался (ended без ответа — «Пропущен» на 15 секунд). hidden — звонки,
 * которые оператор убрал «Скрыть». ext — трубка оператора: если звонит чужой
 * добавочный, блок помечается foreign (без звука).
 */
export function pickRinging(calls, { hidden = new Set(), ext = '' } = {}) {
    const list = (calls || []).filter((c) => c && c.direction === 'in' && LIVE_STATES.has(c.state)
        && !(c.state === 'ended' && c.was_answered) && !hidden.has(c.uuid));
    if (!list.length) return null;
    list.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const call = list[0];
    const foreign = !!(ext && call.callee && String(call.callee) !== String(ext));
    return { call, others: list.length - 1, foreign };
}

/** Имя для блока: пациент, иначе заявка, иначе номер. */
export function ringLabel(c) {
    if (!c) return '';
    if (c.patient && c.patient.full_name) return c.patient.full_name;
    if (c.lead && c.lead.full_name) return c.lead.full_name;
    return formatPhone(c.number || c.caller || '') || String(c.number || c.caller || '');
}

/** Слово состояния для блока и пилюли. Ключи словаря i18n. */
export function ringWord(c) {
    if (!c) return '';
    if (c.state === 'ringing') return 'Входящий звонок';
    if (c.state === 'answered') return 'Разговор идёт';
    return 'Пропущен';
}

/** Пора ли пискнуть: звонит, не выключено, не чужая трубка, прошло 2 с с прошлого и меньше 40 с с начала. */
export function beepDue(c, now, { muted = false, foreign = false, lastBeepAt = 0, firstSeenAt = now } = {}) {
    if (!c || c.state !== 'ringing' || muted || foreign) return false;
    if (now - firstSeenAt > BEEP_MAX_MS) return false;
    return now - lastBeepAt >= BEEP_EVERY_MS;
}

/** Контекст звука: только после жеста пользователя (правило браузеров); нет WebAudio — null. */
export function audioContextOf(win) {
    const Ctor = win && (win.AudioContext || win.webkitAudioContext);
    if (typeof Ctor !== 'function') return null;
    try { return new Ctor(); } catch { return null; }
}

/** Двойной короткий сигнал 880 Гц. ctx — AudioContext (или null: тишина). */
export function ringTone(ctx) {
    if (!ctx || typeof ctx.createOscillator !== 'function') return false;
    try {
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume().catch(() => {});
        const t0 = ctx.currentTime;
        for (const [start, dur] of [[0, 0.18], [0.26, 0.18]]) {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'sine';
            o.frequency.value = 880;
            g.gain.setValueAtTime(0.0001, t0 + start);
            g.gain.exponentialRampToValueAtTime(0.22, t0 + start + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
            o.connect(g).connect(ctx.destination);
            o.start(t0 + start);
            o.stop(t0 + start + dur + 0.05);
        }
        return true;
    } catch { return false; }
}
