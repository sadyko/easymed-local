// BRANCH_PROFILE_V1 — сетка «день недели: работает, с — до». Одна на
// программу: рабочее время сотрудника («Сотрудники», employees.js) и часы
// здания («Филиалы», branch-hours-card.js). Сетка ничего не решает сама:
// каждое изменение дня — onChange(ключ, { on, from, to }); что записать,
// решает экран (сотрудник — тронутый день поверх прежнего графика, как
// всегда; здание — все семь дней).
//
// Замок (disabled / setDisabled) выключает всё; без замка время открыто только
// у отмеченных дней. У полей времени — подписи для читалки экрана («Пн, с»).
// На узком экране строка дня переносится (flex-wrap): без прокрутки вбок.
import { h } from '../ui.js';
import { tr, trf } from '../i18n.js';

export const WEEK_DAYS = Object.freeze([['mon', 'Пн'], ['tue', 'Вт'], ['wed', 'Ср'], ['thu', 'Чт'], ['fri', 'Пт'], ['sat', 'Сб'], ['sun', 'Вс']]);
const OFF = Object.freeze({ on: false, from: '09:00', to: '18:00' });

export function weekHoursGrid(days, { onChange = null, disabled = false } = {}) {
    const wrap = h('div', { class: 'wkh-grid', style: { display: 'grid', gap: '6px' } });
    const rows = {};
    let locked = !!disabled;
    for (const [key, label] of WEEK_DAYS) {
        const d = (days && days[key]) || OFF;
        const chk = h('input', { type: 'checkbox' });
        chk.checked = !!d.on;
        const from = h('input', { type: 'time', style: { width: '110px' } });
        const to = h('input', { type: 'time', style: { width: '110px' } });
        // Свойство, а не только атрибут: поле показывает значение и после правок.
        from.value = d.from || '09:00';
        to.value = d.to || '18:00';
        from.setAttribute('aria-label', trf('{day}, с', { day: tr(label) }));
        to.setAttribute('aria-label', trf('{day}, до', { day: tr(label) }));
        const paint = () => { chk.disabled = locked; from.disabled = locked || !chk.checked; to.disabled = locked || !chk.checked; };
        const commit = () => { paint(); if (typeof onChange === 'function') onChange(key, { on: chk.checked, from: from.value, to: to.value }); };
        chk.addEventListener('change', commit);
        from.addEventListener('change', commit);
        to.addEventListener('change', commit);
        paint();
        rows[key] = { chk, from, to, paint };
        wrap.appendChild(h('div', { class: 'wkh-row', style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0', flexWrap: 'wrap' } },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', width: '80px', cursor: 'pointer' } },
                chk, h('span', { style: { fontWeight: 600, fontSize: '13.5px' } }, label)),
            from, h('span', { class: 'muted', 'aria-hidden': 'true' }, '—'), to));
    }
    return { node: wrap, rows, setDisabled(v) { locked = !!v; for (const r of Object.values(rows)) r.paint(); } };
}
