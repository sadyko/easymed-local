// ACCESS_DENIED_ONE_PLACE_V1 (2026-09-05) — ОДИН отказ на всё приложение.
//
// «Нет доступа» умела рисовать только оболочка (admin.js), и умела только в
// одном виде — панелью во весь экран вместо содержимого маршрута. Пока каждое
// закрытое действие было МАРШРУТОМ, этого хватало. PATIENT_ONE_WINDOW_V1
// сделал заведение пациента ОКНОМ поверх списка, и вместе с маршрутом ушла
// проверка: отказывать стало нечему и нечем (см. PATIENT_CREATE_GATE_V1 в
// permissions.js).
//
// Поэтому отказ переехал сюда и живёт в двух видах ОДНОГО оформления:
//   accessDeniedPanel()      — та самая панель маршрута (её и рисует admin.js);
//   openAccessDeniedDialog() — та же панель в окне, для действия, у которого
//                              своего маршрута нет.
// Текст, значок и цвет — один на оба вида: у пользователя не должно быть двух
// разных «нет доступа» в зависимости от того, каким путём он пришёл. И это
// именно ОТКАЗ, а не тихое ничего: кнопка, которая молча не работает, читается
// как сломанная программа, и человек жмёт её снова и снова.

import { h, Icon } from './ui.js';
import { currentRoleLabel } from './permissions.js';
import { fadeOutAndRemove } from './motion.js?v=mo1';

/**
 * Блок «Нет доступа» — ровно то, что оболочка показывает вместо закрытого
 * маршрута.
 * @param {object}    [opts]
 * @param {Function}  [opts.onHome]     что делать по кнопке возврата; без неё
 *                                      кнопка не рисуется (в окне уходить
 *                                      некуда — окно просто закрывают).
 * @param {string}    [opts.homeLabel]  подпись кнопки возврата.
 */
export function accessDeniedPanel({ onHome, homeLabel = 'Go to my home page' } = {}) {
    const role = currentRoleLabel();
    return h('div', { class: 'error-state', style: { textAlign: 'center', padding: '48px 24px' } },
        h('div', { style: { color: 'var(--crit-700)', display: 'flex', justifyContent: 'center', marginBottom: '10px' } },
            Icon('Warning', { size: 28 })),
        h('div', { style: { fontSize: '17px', fontWeight: 700, color: 'var(--ink-900)' } }, 'No access'),
        h('div', { class: 'muted', style: { marginTop: '4px', fontSize: '13.5px' } },
            role ? `The “${role}” role doesn’t have access to this section.` : 'You don’t have access to this section.'),
        typeof onHome === 'function'
            ? h('button', { class: 'btn btn-outline', style: { marginTop: '16px' }, onclick: onHome }, homeLabel)
            : null,
    );
}

/**
 * Тот же отказ окном — для действия, у которого нет своего маршрута.
 * Возвращает { overlay, close } и НИКОГДА не возвращает null: вызывающая
 * сторона обязана видеть, что отказ показан.
 */
export function openAccessDeniedDialog() {
    const overlay = h('div', { class: 'modal', style: { zIndex: '160' } });
    const close = () => { document.removeEventListener('keydown', onKey); fadeOutAndRemove(overlay); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // .modal-compact — окно оставляет себе свой размер: MODAL_FULLSCREEN_V1
    // растянул бы отказ из шести строк на весь экран (admin.css).
    const card = h('div', {
        class: 'modal-card modal-compact', 'data-dialog': 'access-denied',
        style: { width: '460px' },
    });
    overlay.appendChild(card);
    card.appendChild(h('header', { class: 'modal-head' },
        h('h2', null, 'No access'),
        h('button', { class: 'modal-close', onclick: close }, '×'),
    ));
    const body = h('div', { class: 'modal-body' });
    body.appendChild(accessDeniedPanel());
    card.appendChild(body);

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    return { overlay, card, close };
}
