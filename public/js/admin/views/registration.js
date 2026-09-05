// PATIENT_ONE_WINDOW_V1 (2026-09-05) — заведение пациента переехало со СТРАНИЦЫ
// в ОДНО ОКНО (views/patient-create-modal.js, задача 7 плана
// docs/plans/2026-09-05-ui-redesign-and-calendar.md).
//
// Что здесь осталось и почему.
//
// 1. МАРШРУТ `registration` цел. Он живёт в закладках, в подсказке онбординга и
//    в десятке вызовов onNavigate('registration') по коду; admin.js держит его
//    в своём switch, и трогать его нельзя. Панель маршрута рисуется РЕАЛЬНЫМ
//    содержимым (не пустотой) и сразу поверх открывает то самое окно. Пустая
//    панель была бы хуже 404: admin.js кэширует панели и НЕ перерисовывает их
//    при повторном заходе — возврат на #registration показал бы белый экран.
//
//    Список пациентов под окно НЕ подкладывается намеренно: views/patients.js
//    держит состояние в модульных синглтонах (refs/state), и второй монтаж в
//    панель этого маршрута увёл бы обновление у вкладки «Пациенты», которая
//    монтирует тот же список.
//
// 2. «Госпитализация» — действие прежней шапки страницы — осталось здесь и
//    заведено вторым входом в шапке списка пациентов (views/patients.js), то
//    есть на том экране, где регистратор и находится.
//
// 3. Общие помощники (диалог дубликата, телефонный контрол, чипы-радио,
//    географический каскад) переехали в patient-create-modal.js и
//    ре-экспортируются отсюда: patient-card.js и service-picker-modal.js
//    импортируют их именно по этому адресу.

import { tr } from '../i18n.js';
import { h, Icon, PageHead, clear } from '../ui.js';
import { openPatientCreateModal } from './patient-create-modal.js?v=onewin1';

// Прежние публичные имена этого модуля — за ними ходят другие экраны.
export {
    openDuplicatePatientDialog,
    radioChips,
    phoneInput,
    mailInput,
    geoCascade,
    computeAge,
    categoryFromAge,
} from './patient-create-modal.js?v=onewin1';

export function renderRegistration(container, { onNavigate } = {}) {
    const navigate = typeof onNavigate === 'function' ? onNavigate : () => {};
    clear(container);

    const open = () => openPatientCreateModal({ onNavigate: navigate });

    container.appendChild(h('div', { class: 'fade-in', style: { maxWidth: '760px', margin: '0 auto' } },
        PageHead({
            title: 'Создать пациента',
            subtitle: 'Карта заводится одним окном — без прокрутки и без отдельной страницы',
            right: [
                // ADMISSION_ORDER_V1 — второй вход в стационар. Пациента здесь
                // может быть ещё не выбрано, поэтому окно заявки ищет его само.
                h('button', { class: 'btn', type: 'button', 'data-act': 'admission',
                    onclick: () => import('./admission-modal.js?v=inp2').then((m) => m.openAdmissionOrderModal({})) },
                    Icon('Bed', { size: 14 }), ' ', tr('Госпитализация')),
                h('button', { class: 'btn', type: 'button', onclick: () => navigate('patients') },
                    Icon('Patients', { size: 14 }), ' ', tr('К списку пациентов')),
            ],
        }),
        h('div', { class: 'card' },
            h('div', { class: 'card-pad', style: { display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'flex-start' } },
                h('div', { class: 'muted', style: { fontSize: '13.5px', lineHeight: '1.5' } },
                    tr('Окно заведения пациента открылось поверх этой страницы. Если вы его закрыли — откройте снова.')),
                h('button', { class: 'btn btn-primary', type: 'button', 'data-act': 'open-create-patient', onclick: open },
                    Icon('Plus', { size: 14 }), ' ', tr('Создать пациента')),
            ),
        ),
    ));

    open();
    return { open };
}
