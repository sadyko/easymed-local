// DASH_SHARED_V1 (2026-09-11) — ОБЩИЕ ЧАСТИ СВОДОК: плитка-число и «в один экран».
//
// Сводка клиники (#dashboard) и кабинет врача (#consultation, #consultation/pay)
// показывают числа одной и той же плиткой и одинаково берут высоту окна. Две
// копии плитки разошлись бы при первой правке — и врач видел бы в своём
// кабинете «другую программу», ровно то, о чём владелец говорил про лабораторию
// и задачи медсестры. Поэтому плитка и подгонка живут здесь, а экраны их зовут.
import { h, Icon } from '../ui.js';

// Accent tint per KPI category — fg on the icon glyph, bg behind it (reuses
// the same -700/-50 token pairing as .dash-alert-* / .tag-*).
export const KPI_ACCENT = {
    primary: { fg: 'var(--primary-600)', bg: 'var(--primary-50)' },
    ok:      { fg: 'var(--ok-700)',      bg: 'var(--ok-50)' },
    warn:    { fg: 'var(--warn-700)',    bg: 'var(--warn-50)' },
    crit:    { fg: 'var(--crit-700)',    bg: 'var(--crit-50)' },
    info:    { fg: 'var(--info-700)',    bg: 'var(--info-50)' },
    ward:    { fg: 'var(--purple-700)',  bg: 'var(--purple-50)' },
};

/**
 * Плитка-число в один взгляд: значок и подпись строкой, число под ними, одна
 * строка пояснения. `label` идёт через словарь сама (h() переводит текст).
 */
export function kpiTile({ icon, accent, label, value, meta, split, valueWarn, onClick }) {
    const a = KPI_ACCENT[accent] || KPI_ACCENT.primary;
    return h('div', {
        class: 'dash-kpi',
        'data-reveal': '',
        role: onClick ? 'button' : null,
        tabindex: onClick ? '0' : null,
        onclick: onClick || undefined,
    },
        h('div', { class: 'dash-kpi-top' },
            h('div', { class: 'dash-kpi-icon', style: { color: a.fg, background: a.bg } }, Icon(icon, { size: 15 })),
            h('div', { class: 'dash-kpi-label' }, label),
            onClick ? h('span', { class: 'dash-kpi-go' }, Icon('ArrowRight', { size: 14 })) : null,
        ),
        h('div', {
            class: 'dash-kpi-value num',
            style: valueWarn ? { color: 'var(--warn-700)' } : null,
        }, value),
        meta ? h('div', { class: 'dash-kpi-meta', title: meta }, meta) : null,
        split ? h('div', { class: 'dash-kpi-meta', title: split }, split) : null,
    );
}

/**
 * DASH_ONE_SCREEN_V1 — экран берёт ровно остаток окна под собой.
 *
 * Высота меряется ПО МЕСТУ, а не считается из токенов оболочки: что бы ни
 * стояло над экраном (верхняя строка, зазор, поле области), он получает то,
 * что осталось. Ниже `min` ужиматься дальше некуда — тогда честнее прокрутка,
 * чем нечитаемые графики. Без измеримого окна (тесты) не делает ничего.
 */
const bound = typeof WeakSet === 'function' ? new WeakSet() : null;
export function fitViewport(el, { min = 540, gap = 24 } = {}) {
    if (!el || typeof window === 'undefined' || !el.getBoundingClientRect || !window.innerHeight) return;
    const apply = () => {
        if (el.isConnected === false) return;
        const top = el.getBoundingClientRect().top || 0;
        el.style.height = Math.max(min, Math.round(window.innerHeight - top - gap)) + 'px';
    };
    apply();
    if (bound && !bound.has(el) && typeof window.addEventListener === 'function') {
        bound.add(el);
        window.addEventListener('resize', apply);
    }
}
