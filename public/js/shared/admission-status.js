// INPATIENT_FLOW_V1 — состояния госпитализации, одним списком на оба конца.
//
// Модуль лежит в shared по той же причине, что accommodation-line.js рядом:
// набор состояний пишет СЕРВЕР (rpc/inpatient-flow.js, миграция 091), а
// спрашивает его и БРАУЗЕР — доска коек, кабинет врача, отчёт по занятости.
// Две копии этого списка разошлись бы молча и в самом дорогом месте: экран,
// оставшийся на старом `status = 'active'`, перестал бы видеть поступившего, но
// ещё не осмотренного пациента — койка выглядела бы свободной, и на неё
// положили бы второго.
//
// Маршрут (решение владельца 2026-09-04):
//   ordered → admitted → examined → active → discharging → discharged
//   и из любого ДО active — cancelled

// Порядок шагов. Индекс = «как далеко зашла госпитализация».
export const ADMISSION_FLOW = ['ordered', 'admitted', 'examined', 'active', 'discharging', 'discharged'];

// ПАЦИЕНТ В КОЙКЕ. Койка занята, суточное начисление идёт, второй
// госпитализации у этого пациента быть не может.
//
// До миграции 091 «в койке» значило ровно 'active', и так написано во всех
// старых запросах. Теперь между поступлением и лечением есть два шага, и
// пациент всё это время лежит: считать «в койке» только 'active' — значит не
// брать денег за первые сутки и показывать занятую койку свободной.
export const IN_BED_STATUSES = ['admitted', 'examined', 'active', 'discharging'];

// Госпитализация ОТКРЫТА: ещё не выписан и не отменён. Отличается от
// IN_BED_STATUSES ровно на 'ordered' — заявка есть, койки ещё нет.
export const OPEN_STATUSES = ['ordered', ...IN_BED_STATUSES];

// Закончена: назад с этих состояний хода нет (TERMINAL в domain/lifecycle.js).
export const CLOSED_STATUSES = ['discharged', 'cancelled'];

export const isInBed = (status) => IN_BED_STATUSES.includes(status);
export const isOpenAdmission = (status) => OPEN_STATUSES.includes(status);

// Подписи для экранов. Ключ перевода — сама русская строка: ui.js h() прогоняет
// текстовые узлы через tr(), а i18n-strings.js держит ru/en/uz.
export const ADMISSION_STATUS_LABEL = {
    ordered:     'Ждёт размещения',
    admitted:    'На койке',
    examined:    'Осмотрен',
    active:      'Лечение',
    discharging: 'Оформляется выписка',
    discharged:  'Выписан',
    cancelled:   'Отменена',
};

export const admissionStatusLabel = (status) => ADMISSION_STATUS_LABEL[status] || status || '—';
