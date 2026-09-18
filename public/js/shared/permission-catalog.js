// PERMISSION_CATALOG_V1 (2026-09-18) — ЧТО В ПРОГРАММЕ МОЖНО РАЗРЕШИТЬ, ОДНИМ СПИСКОМ.
//
// Владелец: «we need to setup a roles and permissions as they should … by every
// section and every option of the section … also actions like, in the
// stationary, adding prescriptions, adding measurements etc. deleting, view and
// editing options too … so user who assigns the functions and roles understands
// what he's doing».
//
// ЭТОТ ФАЙЛ — ЕДИНСТВЕННЫЙ СПИСОК ПРАВ. Его читают ОБА конца: экран «Роли» рисует
// из него матрицу, а сервер по нему решает, пускать ли (server/services/grants.js).
// Второй копии списка быть не может: она разошлась бы с первой через один
// выпуск, и галочка на экране перестала бы значить то, что проверяет сервер.
//
// ТРИ ЯРУСА. Раздел → окно → действие.
//   раздел   — пункт меню («Стационар»);
//   окно     — вкладка внутри раздела («Заявки», «Койки»);
//   действие — то, что человек ДЕЛАЕТ в окне и что сервер проверяет отдельно
//              («добавляет назначение», «удаляет измерение»).
//
// ЧЕТЫРЕ УРОВНЯ, и у каждого одно значение на всю программу:
//   none   — ничего: раздела нет в меню, действие отказано;
//   view   — видит;
//   edit   — видит и меняет: добавляет, правит, отмечает;
//   delete — всё выше и ещё удаляет.
// Уровни ВЛОЖЕНЫ: delete включает edit, edit включает view. Поэтому у строки
// перечислены только те уровни, которые в ней ЧТО-ТО значат: у окна, где нечего
// удалять, выбора «удаление» нет — иначе это была бы галочка-обманка.
//
// ЧЕСТНОСТЬ. Строка попадает в матрицу только если у неё есть `enforced` —
// имя настоящей проверки на сервере или в оболочке. Тест сверяет: у каждой
// строки проверка есть, и каждая проверка описана здесь. Право, которого код не
// проверяет, показать нельзя: заведующая, поставившая «только просмотр», должна
// получить только просмотр, а не ту же кассу с теми же кнопками.
//
// ИМЕНА. Ключ — латиница через точку: 'inpatient.vitals'. Подписи — по-русски,
// словами клиники, и с описанием, ЧТО именно даёт уровень: человек, который
// раздаёт права, должен понимать последствие каждой галочки, не открывая код.

export const LEVELS = ['none', 'view', 'edit', 'delete'];
export const LEVEL_LABELS = { none: 'Нет', view: 'Просмотр', edit: 'Изменение', delete: 'Удаление' };
const RANK = { none: 0, view: 1, edit: 2, delete: 3 };

/** Даёт ли выданный уровень то, что требуется: 'edit' покрывает 'view'. */
export function levelAllows(have, need) {
  return (RANK[have] || 0) >= (RANK[need] || 0);
}

/**
 * Справочник. У раздела: key, label, desc, levels, windows[], actions[],
 * `legacy` — ключ старой матрицы (permissions.js NAV_MODULES), по которому
 * работают уже существующие ворота, пока они не переведены на новые ключи.
 * У окна/действия: key, label, desc, levels, enforced (что проверяет).
 */
export const CATALOG = [
  {
    key: 'patients', label: 'Пациенты', legacy: 'patients',
    desc: 'Картотека клиники: карты, визиты, очередь и календарь записи.',
    levels: ['none', 'view', 'edit', 'delete'],
    levelDesc: {
      view: 'Видит картотеку и карты пациентов.',
      edit: 'Заводит и правит пациентов, записывает на приём.',
      delete: 'Удаляет визит, неоплаченную услугу из сметы и рекомендацию.',
    },
    windows: [
      { key: 'patients.list',     label: 'Список',   desc: 'Картотека и карта пациента.', levels: ['none', 'view'], enforced: 'route:patients' },
      { key: 'patients.queue',    label: 'Очередь',  desc: 'Доска номеров: кто у какого врача, в лаборатории и на процедурах.', levels: ['none', 'view'], enforced: 'route:patients/queue' },
      { key: 'patients.calendar', label: 'Записи',   desc: 'Календарь записи по врачам и кабинетам.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Записывает, переносит и отменяет записи.' }, enforced: 'route:patients/calendar' },
    ],
    actions: [],
  },
  {
    key: 'crm', label: 'CRM · Заявки', legacy: 'crm',
    desc: 'Обращения и лиды, звонки, превращение заявки в пациента.',
    levels: ['none', 'view', 'edit'],
    levelDesc: { view: 'Видит доску заявок.', edit: 'Ведёт заявки: берёт в работу, двигает по воронке, записывает.' },
    windows: [], actions: [],
  },
  {
    key: 'doctor', label: 'Кабинет врача', legacy: 'consultation',
    desc: 'Рабочее место врача: приёмы, заключения, назначения, оплаты.',
    levels: ['none', 'view'],
    levelDesc: { view: 'Открывает кабинет с теми окнами, что отмечены ниже.' },
    windows: [
      { key: 'doctor.dashboard',  label: 'Дашборд',    desc: 'Сводка врача за день.', levels: ['none', 'view'], enforced: 'route:consultation' },
      { key: 'doctor.visits',     label: 'Мои визиты', desc: 'Очередь и приёмы: заключение, направление на услуги.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Пишет заключение, назначает и направляет.' }, enforced: 'route:consultation/work' },
      { key: 'doctor.inpatients', label: 'Стационар',  desc: 'Мои пациенты в стационаре.', levels: ['none', 'view'], enforced: 'route:consultation/inpatients' },
      { key: 'doctor.pay',        label: 'Оплаты',     desc: 'Вознаграждение врача за услуги.', levels: ['none', 'view'], enforced: 'route:consultation/pay' },
      { key: 'doctor.profile',    label: 'Профиль',    desc: 'Свои специальности и шаблоны.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Правит свой профиль и шаблоны.' }, enforced: 'route:consultation/profile' },
    ],
    actions: [],
  },
  {
    key: 'labs', label: 'Лаборатория', legacy: 'labs',
    desc: 'Рабочий список и результаты анализов.',
    levels: ['none', 'view', 'edit', 'delete'],
    levelDesc: { view: 'Видит список и результаты.', edit: 'Вносит и подтверждает результаты.', delete: 'Удаляет показатель из бланка результата.' },
    windows: [], actions: [],
  },
  {
    key: 'procedures', label: 'Процедуры', legacy: 'procedures',
    desc: 'Очередь процедур медсестры.',
    levels: ['none', 'view', 'edit'],
    levelDesc: { view: 'Видит очередь процедур.', edit: 'Отмечает выполнение.' },
    windows: [], actions: [],
  },
  {
    key: 'inpatient', label: 'Стационар', legacy: 'beds',
    desc: 'Заявки на госпитализацию, койки, истории болезни и всё, что делают с лежащим пациентом.',
    levels: ['none', 'view'],
    levelDesc: { view: 'Открывает раздел с теми окнами, что отмечены ниже.' },
    windows: [
      { key: 'inpatient.requests', label: 'Заявки',         desc: 'Заявки на госпитализацию: кого и куда класть.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Создаёт заявку и размещает на койку.' }, enforced: 'rpc:admission_order_create' },
      { key: 'inpatient.patients', label: 'Пациенты',       desc: 'История болезни лежащего пациента: обзор, осмотры, документы.', levels: ['none', 'view'], enforced: 'rpc:case_overview' },
      { key: 'inpatient.beds',     label: 'Койки',          desc: 'Коечный фонд: кто где лежит, свободные и на уборке.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Меняет состояние койки.' }, enforced: 'rpc:bed_set_status' },
      { key: 'inpatient.history',  label: 'Госпитализации', desc: 'Журнал госпитализаций по образцу клиники, с выгрузкой в Excel.', levels: ['none', 'view'], enforced: 'rpc:admissions_register' },
    ],
    actions: [
      { key: 'inpatient.prescriptions', label: 'Назначения',  desc: 'Лист назначений: препараты, дозы, время.', levels: ['none', 'view', 'edit', 'delete'], levelDesc: { view: 'Видит лист назначений.', edit: 'Добавляет и правит назначения.', delete: 'Отменяет назначение.' }, enforced: 'rpc:treatment_orders' },
      { key: 'inpatient.marks',         label: 'Отметки о введении', desc: 'Медсестра отмечает, что препарат дан.', levels: ['none', 'view', 'edit', 'delete'], levelDesc: { view: 'Видит отметки.', edit: 'Ставит отметку «дано».', delete: 'Снимает любую отметку, в том числе чужую.' }, enforced: 'rpc:treatment_mark' },
      { key: 'inpatient.vitals',        label: 'Измерения',   desc: 'Температура, давление, пульс, сатурация.', levels: ['none', 'view', 'edit', 'delete'], levelDesc: { view: 'Видит измерения.', edit: 'Записывает измерение.', delete: 'Удаляет ошибочное измерение.' }, enforced: 'rpc:vitals' },
      { key: 'inpatient.reviews',       label: 'Осмотры',     desc: 'Дневник осмотров лечащего врача.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Читает осмотры.', edit: 'Пишет и публикует осмотр.' }, enforced: 'rpc:inpatient_reviews' },
      { key: 'inpatient.services',      label: 'Услуги в стационаре', desc: 'Услуги и процедуры, добавленные лежащему пациенту.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит список услуг.', edit: 'Добавляет услугу и отмечает выполнение.' }, enforced: 'rpc:admission_services' },
      { key: 'inpatient.discharge',     label: 'Выписка',     desc: 'Выписать пациента из стационара.', levels: ['none', 'edit'], levelDesc: { edit: 'Выписывает.' }, enforced: 'rpc:discharge' },
    ],
  },
  {
    key: 'mar', label: 'Лист назначений (медсестра)', legacy: 'beds',
    desc: 'Окно медсестры: что дать, кому и когда.',
    levels: ['none', 'view'],
    levelDesc: { view: 'Открывает окно с теми вкладками, что отмечены ниже.' },
    windows: [
      { key: 'mar.outpatient', label: 'Амбулаторные', desc: 'Назначения амбулаторным пациентам.', levels: ['none', 'view'], enforced: 'route:mar-nurse/outpatient' },
      { key: 'mar.inpatient',  label: 'Стационар',    desc: 'Назначения лежащим пациентам.', levels: ['none', 'view'], enforced: 'route:mar-nurse' },
    ],
    actions: [],
  },
  { key: 'kitchen',     label: 'Порционник',          legacy: 'beds', desc: 'Лист питания стационара для кухни.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит порционник.', edit: 'Назначает стол.' }, windows: [], actions: [], enforced: 'route:kitchen-sheet' },
  { key: 'discharges',  label: 'Выписки',             legacy: 'beds', desc: 'Очередь выписки и выписные документы.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит очередь выписки.', edit: 'Готовит и завершает выписку.' }, windows: [], actions: [], enforced: 'route:discharge' },
  { key: 'documents',   label: 'Документы',           legacy: 'patient-documents', desc: 'Печатные документы по пациентам.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Печатает документы.', edit: 'Заполняет и правит документы.' }, windows: [], actions: [] },
  { key: 'chat',        label: 'Чат с пациентами',    legacy: 'telegram-chat', desc: 'Переписка в Telegram-боте.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Читает переписку.', edit: 'Отвечает пациенту от имени клиники.' }, windows: [], actions: [] },
  { key: 'cashier',     label: 'Касса',               legacy: 'cashier', desc: 'Смена кассира и приём оплат.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит смену и счета.', edit: 'Принимает оплату, открывает и закрывает смену.' }, windows: [], actions: [] },
  { key: 'cashier_head',label: 'Старший кассир',      legacy: 'cashier-head', desc: 'Все смены и сверка.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит все смены.', edit: 'Проводит сверку и правит смены.' }, windows: [], actions: [] },
  { key: 'procurement', label: 'Закупки',             legacy: 'inventory', desc: 'Товары, остатки, поступления, заявки на закупку.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит склад и остатки.', edit: 'Оформляет приход, заявки и списания.' }, windows: [], actions: [
      // DEPARTMENTS_V1 — выдача со склада получателю (отдел, кабинет, сотрудник):
      // ворота issue_stock_lines. По умолчанию — администратор и снабженец.
      { key: 'procurement.issue', label: 'Выдача со склада', desc: 'Выдать товар отделу, кабинету или сотруднику.', levels: ['none', 'edit'], levelDesc: { edit: 'Выдаёт товар со склада получателю; склад списывается, получатель получает остаток.' }, enforced: 'rpc:issue_stock_lines' },
    ] },
  { key: 'dashboard',   label: 'Дашборд',             legacy: 'dashboard', desc: 'Сводка по клинике за день.', levels: ['none', 'view'], windows: [], actions: [] },
  { key: 'reports',     label: 'Отчёты',              legacy: 'reports-hub', desc: 'Отчёты за период и выгрузка в Excel.', levels: ['none', 'view'], windows: [], actions: [] },
  { key: 'settings',    label: 'Настройки',           legacy: 'settings', desc: 'Вся конфигурация клиники: услуги, сотрудники, роли, телефония.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Смотрит настройки.', edit: 'Меняет настройки.' }, windows: [
      // DEPARTMENTS_V1 — экран «Отделы»: список, карточка, формирование.
      { key: 'settings.departments', label: 'Отделы', desc: 'Отделы клиники: руководитель, команда, помещения, снабжение.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит список отделов и их карточки.', edit: 'Формирует отделы: руководитель, команда, помещения.' }, enforced: 'rpc:department_form' },
    ], actions: [] },
];

/** Все строки матрицы плоским списком: раздел, его окна и действия. */
export function catalogRows() {
  const rows = [];
  for (const s of CATALOG) {
    rows.push({ ...s, kind: 'section', parent: null });
    for (const w of s.windows || []) rows.push({ ...w, kind: 'window', parent: s.key });
    for (const a of s.actions || []) rows.push({ ...a, kind: 'action', parent: s.key });
  }
  return rows;
}

export function catalogByKey() {
  const m = new Map();
  for (const r of catalogRows()) m.set(r.key, r);
  return m;
}

/** Ключи старой матрицы (NAV_MODULES), которыми ещё живут старые ворота. */
export function legacyKeyOf(sectionKey) {
  const s = CATALOG.find((x) => x.key === sectionKey);
  return s ? s.legacy || null : null;
}
