// Registrar view tabs — «База пациентов · Календарь записи · Мой дашборд».
//
// NO_GREETING_V1 (2026-09-05) — this file used to be the Aurora greeting band:
// a teal panel with «Доброе утро, <имя>», a warm paragraph about caring for
// patients, a live 1-second clock and the RU date. The owner asked for the
// greeting bands to go (docs/plans/2026-09-05-ui-redesign-and-calendar.md,
// задача 3). What could NOT go with them is what was living inside the band —
// these three view tabs, the only way to reach «Календарь записи» and «Мой
// дашборд» from the patient base. So the band is gone and the tabs stayed,
// which is all this module is now.
//
// Two consequences worth recording:
//   1. There is no interval here any more. The clock was module-global state
//      (`_regClockTimer`) shared by every caller, which is why patients.js and
//      room-calendar.js importing this file under DIFFERENT ?v= tags — two
//      module instances, two independent timers — was a live hazard. With the
//      clock gone the duplicate instance is harmless; unifying the tags is a
//      one-line cleanup for whoever next edits those two views.
//   2. `registrarHeader({ active, onNavigate })` keeps its name and signature
//      on purpose: patients.js:202 and room-calendar.js:88 call it today, and
//      the «Пациенты» three-tab host (задача 4) inherits this strip as-is.
//
//   active     : 'patients' | 'appointments' | 'dashboard'  (which tab is lit)
//   onNavigate : the view's navigate fn — onNavigate('patients'|'appointments'|'dashboard')

import { h, Icon } from '../ui.js';
import { isModuleAllowed } from '../permissions.js';   // ROLE_AUDIT_V1 (fix #6)

const TABS = [
    { id: 'patients',     label: 'База пациентов',   icon: 'Patients' },
    { id: 'appointments', label: 'Календарь записи', icon: 'Calendar' },
    { id: 'dashboard',    label: 'Мой дашборд',      icon: 'Activity' },
];
// ROLE_AUDIT_V1 (fix #6) — only show tab chips the role can actually open
// (clicking a hidden one previously just hit the access-denied panel).
const visibleTabs = () => TABS.filter(t => isModuleAllowed(t.id));

export function registrarHeader({ active = 'patients', onNavigate } = {}) {
    const tabBtn = (t) => h('button', {
        class: 'reg-tab' + (t.id === active ? ' on' : ''),
        type: 'button',
        'aria-current': t.id === active ? 'page' : null,
        onclick: () => {
            if (t.id === active) return;
            if (typeof onNavigate === 'function') onNavigate(t.id);
        },
    }, Icon(t.icon, { size: 14 }), h('span', null, t.label));

    return h('div', { class: 'reg-tabs' }, ...visibleTabs().map(tabBtn));
}
