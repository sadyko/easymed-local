// BRANCH_PROFILE_V1 — «Часы работы» здания: три способа и сетка дней;
// предупреждение «эти врачи потеряют часы приёма» до сохранения (спецификация,
// «Часы работы филиала»). Что считать — сервер (RPC branch_hours_impact), здесь
// только показ и выбор человека.
//
// Способы (решение плана Р6): «Не ограничивать» — '{}', как у всех зданий до
// шага 4; «По дням недели» — все семь дней; «Круглосуточно» — is_24_7.
// Часы ограничивают каждого, к кому записывают, — врачей, медсестёр и других исполнителей
// услуг (медсестра с процедурами), — у кого в «Сотрудниках» выбрано это
// здание; сотрудников без здания — нет (ответ владельца 2026-10-10: как сейчас;
// ревью шага 4, находка 4: не только врачей).
import { h, Icon, clear } from '../ui.js';
import { tr } from '../i18n.js';
import { weekHoursGrid, WEEK_DAYS } from './week-hours.js';
import { fieldErr } from './company-fields.js';

export const DAY_LABEL = Object.freeze(Object.fromEntries(WEEK_DAYS));
const MODES = [
    ['none', 'Не ограничивать', 'Врачи, медсёстры и другие исполнители этого здания принимают по своему графику из «Сотрудников». Так сейчас у всех зданий.'],   // ревью 4 — не только врачи
    ['week', 'По дням недели', 'Вне этих часов запись к сотрудникам этого здания не предлагается.'],   // ревью 4 — не только к врачам
    ['allday', 'Круглосуточно', 'Например, стационар или дежурная лаборатория.'],
];
// Ревью 4 — роль исполнителя-не врача в предупреждении. RPC (7e43f859) отдаёт
// role: 'doctor'; роль исполнителя процедур ('nurse', 'senior_nurse',
// 'head_doctor'); или users.role исполнителя по ставкам (любая основная роль).
// Незнакомая и пустая — общим «Исполнитель», никогда не сырым ключом. Ответ
// сервера старше — без role: там были только врачи.
const ROLE_LABEL = Object.freeze({
    doctor: 'Врач', nurse: 'Медсестра', registrar: 'Регистратор', cashier: 'Кассир', lab: 'Лаборант',
    admin: 'Администратор', inventory: 'Склад', callcenter: 'Оператор колл-центра',
    head_doctor: 'Главный врач', senior_nurse: 'Старшая медсестра', head_cashier: 'Старший кассир',
});
const isDoctor = (d) => d.role == null || d.role === 'doctor';
const roleLabel = (role) => tr(Object.prototype.hasOwnProperty.call(ROLE_LABEL, role) ? ROLE_LABEL[role] : 'Исполнитель');
let seq = 0;

/** Потерянное время сотрудника одной строкой: «Пн 18:00–20:00, Сб 09:00–15:00». */
export function lostText(lost) {
    return (lost || []).map((l) => tr(DAY_LABEL[l.day] || l.day) + ' ' + l.from + '–' + l.to).join(', ');
}

/**
 * hours — { mode, days } экрана (меняется на месте). askImpact(doctors) →
 * Promise<boolean>: «Сохранить всё равно» — true; «Вернуться к часам» или
 * любая правка часов, пока вопрос открыт, — false (сохранение не повисает).
 */
export function hoursCard(hours, { disabled = false, onChange = null } = {}) {
    const name = 'brf-hours-' + (++seq);
    const err = fieldErr(null);
    // Ревью 8 — у ошибки часов есть поле: экран прокручивает к нему и ставит
    // фокус. 'noDay' — понедельник; ключ дня — «до» этого дня; иначе — способ.
    function pointAt(target) {
        const next = target === 'noDay' ? grid.rows.mon.chk
            : (target && grid.rows[target]) ? grid.rows[target].to
            : (radios[hours.mode] || radios.week);
        if (err.ctrl && err.ctrl !== next && typeof err.ctrl.removeAttribute === 'function') err.ctrl.removeAttribute('aria-invalid');
        err.ctrl = next;
    }
    const impactSlot = h('div', { class: 'brf-impact-slot' });
    let pending = null;
    function clearImpact() {
        clear(impactSlot);
        if (pending) { const p = pending; pending = null; p(false); }
    }
    const changed = () => { err.set(''); clearImpact(); if (typeof onChange === 'function') onChange(); };
    const grid = weekHoursGrid(hours.days, {
        disabled: disabled || hours.mode !== 'week',
        onChange: (key, entry) => { hours.days[key] = entry; changed(); },
    });
    const radios = {};
    const modes = h('div', { class: 'brf-modes', role: 'radiogroup', 'aria-label': 'Часы работы' },
        ...MODES.map(([mode, label, hint]) => {
            const r = h('input', { type: 'radio', name, value: mode });
            r.disabled = disabled;
            r.addEventListener('change', () => { if (!r.checked) return; hours.mode = mode; paint(); changed(); });
            radios[mode] = r;
            return h('label', { class: 'brf-mode' }, r, h('b', null, label), h('span', null, hint));
        }));
    function paint() {
        for (const [m, r] of Object.entries(radios)) r.checked = hours.mode === m;
        grid.node.hidden = hours.mode !== 'week';
        grid.setDisabled(disabled || hours.mode !== 'week');
    }
    function askImpact(doctors) {
        clearImpact();
        return new Promise((resolve) => {
            pending = resolve;
            const done = (v) => { pending = null; clear(impactSlot); resolve(v); };
            const headId = name + '-impact';
            const backBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => done(false) }, 'Вернуться к часам');
            const allDoctors = doctors.every(isDoctor);
            impactSlot.appendChild(h('div', { class: 'brf-impact', role: 'alertdialog', 'aria-labelledby': headId },
                h('p', { class: 'brf-impact-head', id: headId }, Icon('Warning', { size: 16 }), ' ',
                    allDoctors ? 'Эти врачи потеряют часы приёма' : 'Эти сотрудники потеряют часы приёма'),
                h('ul', null, ...doctors.map((d) => h('li', null,
                    h('b', null, document.createTextNode(d.name || '—')),
                    isDoctor(d) ? null : h('span', { class: 'brf-role' }, document.createTextNode(' (' + roleLabel(d.role) + ')')),
                    document.createTextNode(' — ' + lostText(d.lost))))),
                h('p', { class: 'cpf-hint' }, 'Уже записанные пациенты не отменяются; новых записей на это время программа не предложит. Считается по тем, у кого в «Сотрудниках» выбрано это здание.'),
                h('div', { class: 'cpf-row' },
                    h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => done(true) }, 'Сохранить всё равно'),
                    backBtn)));
            // Вопрос — туда, где человек его увидит; фокус — на безопасный ответ.
            try { impactSlot.scrollIntoView({ block: 'nearest' }); } catch (_) { /* старый браузер */ }
            try { backBtn.focus({ preventScroll: true }); } catch (_) { /* кнопка исчезла */ }
        });
    }
    paint();
    const node = h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Clock', { size: 16 }), ' ', 'Часы работы')),
        h('div', { class: 'cpf-body' }, modes, grid.node,
            h('p', { class: 'cpf-hint' }, 'Часы ограничивают каждого сотрудника, к которому можно записать пациента, — врачей, медсестёр и других исполнителей, — если в «Сотрудниках» у него выбрано это здание. Сотрудников без выбранного здания они не ограничивают.'),   // ревью 4
            err.node, impactSlot));
    return { node, err, askImpact, clearImpact, paint, pointAt };
}
