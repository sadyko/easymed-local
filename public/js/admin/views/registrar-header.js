// Registrar shell header — ported from Aurora RegGreet (reg-base.jsx), rendered
// in EasyMed's teal skin. Exposes registrarHeader({ active, onNavigate }).
//
//   active     : 'patients' | 'appointments' | 'dashboard'  (which tab is lit)
//   onNavigate : the view's navigate fn — onNavigate('patients'|'appointments'|'dashboard')
//
// The header carries a LIVE clock (1s tick). Only ONE interval may ever run:
// each call to registrarHeader() clears the previously-registered interval
// before starting a new one, so navigating between views never stacks ticks.

import { h, Icon } from '../ui.js';
import { currentUser } from '../data.js';
import { isModuleAllowed } from '../permissions.js';   // ROLE_AUDIT_V1 (fix #6)

// RU weekday names, index = Date.getDay() (0 = Sunday).
const RG_WD = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
// RU month names, genitive case, index = Date.getMonth() (0 = January).
const RG_MO = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля',
    'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const z = (n) => String(n).padStart(2, '0');

// Module-global so we can clear the previous header's clock on every re-render.
let _regClockTimer = null;

function ruDateLabel(d) {
    return `${RG_WD[d.getDay()]}, ${d.getDate()} ${RG_MO[d.getMonth()]} ${d.getFullYear()}`;
}
function ruTimeLabel(d) {
    return `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}
function greetPart(h24) {
    if (h24 < 12) return 'Доброе утро';
    if (h24 < 17) return 'Добрый день';
    return 'Добрый вечер';
}

const TABS = [
    { id: 'patients',     label: 'База пациентов',   icon: 'Patients' },
    { id: 'appointments', label: 'Календарь записи', icon: 'Calendar' },
    { id: 'dashboard',    label: 'Мой дашборд',      icon: 'Activity' },
];
// ROLE_AUDIT_V1 (fix #6) — only show tab chips the role can actually open
// (clicking a hidden one previously just hit the access-denied panel).
const visibleTabs = () => TABS.filter(t => isModuleAllowed(t.id));

export function registrarHeader({ active = 'patients', onNavigate } = {}) {
    // Never stack clocks: kill any interval a prior header left running.
    if (_regClockTimer) { clearInterval(_regClockTimer); _regClockTimer = null; }

    const me = currentUser();
    const firstName = ((me && (me.full_name || me.username)) || '').trim().split(/\s+/)[0] || '';
    const now = new Date();
    const part = greetPart(now.getHours());
    const greetLine = firstName ? `${part}, ${firstName}!` : `${part}!`;

    // Live clock element (mono); updated in place every second.
    const timeB = h('b', { class: 'num' }, ruTimeLabel(now));
    _regClockTimer = setInterval(() => {
        // Self-heal: if the header was removed from the DOM, stop ticking.
        if (!timeB.isConnected) { clearInterval(_regClockTimer); _regClockTimer = null; return; }
        timeB.textContent = ruTimeLabel(new Date());
    }, 1000);

    const tabBtn = (t) => h('button', {
        class: 'segmented-btn' + (t.id === active ? ' on' : ''),
        type: 'button',
        onclick: () => {
            if (t.id === active) return;
            if (typeof onNavigate === 'function') onNavigate(t.id);
        },
    }, Icon(t.icon, { size: 14 }), h('span', null, t.label));

    return h('div', { class: 'reg-greet' },
        // LEFT — id block + greeting + warm message
        h('div', { class: 'reg-greet-main' },
            h('div', { class: 'reg-greet-id' },
                h('div', { class: 'reg-greet-title' }, 'Пациенты'),
                h('div', { class: 'reg-greet-sub' }, 'База пациентов'),
            ),
            h('div', { class: 'reg-greet-msg' },
                h('div', { class: 'reg-greet-hello' }, greetLine),
                h('div', { class: 'reg-greet-warm' },
                    'Пациент — в центре всего, что мы делаем. Тёплая встреча, внимание и улыбка важны не меньше, чем точность данных: помогите каждому почувствовать заботу с первой минуты. Спасибо за вашу работу — вы лицо клиники.',
                ),
            ),
        ),
        // RIGHT — live clock + RU date, then the 3 view tabs
        h('div', { class: 'reg-greet-ctrl' },
            h('div', { class: 'reg-now' },
                h('span', { class: 'reg-now-date' }, Icon('Calendar', { size: 14 }), h('span', null, ruDateLabel(now))),
                h('span', { class: 'reg-now-time' }, Icon('Clock', { size: 14 }), timeB),
            ),
            h('div', { class: 'segmented reg-viewtabs' }, ...visibleTabs().map(tabBtn)),   // ROLE_AUDIT_V1 (fix #6)
        ),
    );
}
