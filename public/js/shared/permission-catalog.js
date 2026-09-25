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
// ГДЕ ИМЕННО ПРОВЕРЯЮТ — говорит приставка, и она обязана быть ПРАВДОЙ:
//   rpc:<имя>    — ворота серверного вызова (services/rpc/…, requireGrant);
//   route:<имя>  — маршрут оболочки (permissions.js isRouteAllowed);
//   client:<имя> — предикат оболочки, и ТОЛЬКО он: сервер этот ключ не читает;
//   db:<таблица> — запись в таблицу через /api/db: у таблицы в реестре
//                  (server/db/schema-registry.js) стоит `write.grant` с этим
//                  ключом, и компилятор запросов пускает того, кому он выдан
//                  (db/write-grant.js, ROLE_REPORTS_SETTINGS_V1). У закрытой
//                  строки (`locked`) это та проверка, что оставляет запись
//                  только администратору.
// Приставка client: — предупреждение, а не разрешение писать что угодно: такое
// право закрывает кнопку, но не запрещает действие тому, кто дойдёт до сервера
// другим путём, поэтому у него обязана быть своя серверная опора, названная в
// описании строки.
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
 * ROLE_REPORTS_SETTINGS_V1 — у окна ещё бывают `group` (подзаголовок, под
 * которым экран «Роли» его рисует), `legacyKeys` (см. раздел «Настройки») и
 * `locked` (только администратор: строка видна, выдать её нельзя).
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
    // CALLCENTER_OPERATOR_V1 (2026-09-21) — РАБОТА ОПЕРАТОРА СТАЛА СТРОКАМИ МАТРИЦЫ.
    //
    // Доска заявок была ОДНОЙ галочкой, а всё, что оператор на ней делает —
    // журнал звонков, набор номера, запись разговора, заведение карты, — решал
    // код списками ролей ['admin','registrar','callcenter'] (rpc/telephony.js).
    // Выдать это своей роли клиники было нельзя ничем, и отнять у штатной —
    // тоже: заведующая видела «CRM: изменение» и не могла узнать, что за ней
    // ещё и право позвонить и прослушать чужой разговор.
    windows: [
      { key: 'crm.calls', label: 'Звонки и записи разговоров', desc: 'Журнал звонков этого человека в карточке заявки: кто звонил, когда и сколько говорили.', levels: ['none', 'view'], enforced: 'rpc:crm_lead_calls' },
    ],
    actions: [
      { key: 'crm.dial',      label: 'Позвонить пациенту',        desc: 'Набор номера из программы: звонок уходит с ТРУБКИ САМОГО сотрудника (внутренний номер берётся из сессии), поэтому разбор по операторам считает его этому человеку.', levels: ['none', 'edit'], levelDesc: { edit: 'Звонит пациенту из заявки, карты и очереди.' }, enforced: 'rpc:telephony_dial' },
      { key: 'crm.recording', label: 'Прослушать запись',         desc: 'Запись разговора — это голос пациента: видеть строку в журнале и слушать сам разговор это разные права.', levels: ['none', 'edit'], levelDesc: { edit: 'Открывает и слушает записи разговоров.' }, enforced: 'rpc:telephony_call_recording' },
      // Проверка — ОКНО заведения карты в оболочке (permissions.js
      // canCreatePatient), и приставка говорит об этом прямо: сервер ключа
      // `crm.convert` не читает. Его опора другая и не настраиваемая — реестр
      // таблиц (schema-registry.js: вставку в patients делают admin, registrar и
      // callcenter), поэтому выданная строка откроет окно, но роли с другой
      // ОСНОВОЙ сервер сохранить карту всё равно не даст.
      //
      // «Нет» по этой строке ничего не отнимает: право заведения карты даёт ещё
      // и прежний ключ `registration`, и оболочка спрашивает новый ТОЛЬКО как
      // прибавку — иначе первое же сохранение роли на этом экране оставило бы
      // без карт всех, у кого работает прежний ключ.
      { key: 'crm.convert',   label: 'Завести пациента из заявки', desc: 'Превратить обращение в карту пациента, не открывая регистратуру. Открывает то же окно, что «+ Новый пациент»; сохранить карту сервер разрешает регистратуре, колл-центру и администратору.', levels: ['none', 'edit'], levelDesc: { edit: 'Заводит карту пациента из заявки.' }, enforced: 'client:canCreatePatient' },
      // CRM_HEAD_MERGE_TAGS_V1 (2026-09-25) — «РУКОВОДИТЕЛЬ КОЛЛ-ЦЕНТРА» ГАЛОЧКОЙ.
      //
      // Оператор видит свои заявки и ничьи (CRM_OWNERSHIP_V1), и до сих пор
      // ВСЮ доску видел только администратор — поэтому руководителю смены
      // нечем было передать заявку заболевшего оператора, кроме админского
      // входа. Эта строка снимает ограничение с любой роли, которой её дали:
      // один ключ читают сужение доски в компиляторе запросов
      // (schema-registry.js crm_requests.scope.allGrant), поиск и проверка
      // дубля (rpc/crm-leads.js), показатели звонков (telephony_operator_stats),
      // слияние дублей (crm_merge_leads) и отчёт колл-центра. Удалять заявки
      // по-прежнему может только администратор.
      { key: 'crm.all',       label: 'Видит все заявки и передаёт их', desc: 'Руководитель колл-центра: видит все карточки, а не только свои и ничьи, передаёт заявку другому оператору, видит звонки каждого оператора и просроченные задачи всей команды, объединяет дубли. Удалять заявки может только администратор.', levels: ['none', 'edit'], levelDesc: { edit: 'Видит и передаёт все заявки, объединяет дубли.' }, enforced: 'rpc:telephony_operator_stats' },
    ],
  },
  // CALLCENTER_OPERATOR_V1 — Cust Dev звонит ТОТ ЖЕ оператор, и до сих пор это
  // право жило только старым ключом раздела (`custdev`), которого в справочнике
  // не было вовсе: экран «Роли» его не рисовал, и выдавался он лишь миграцией
  // 078. Раздел получает строки, а его ворота (rpc/custdev.js) — правило
  // перехода: пока роль ключ не трогала, решает прежняя галочка раздела.
  {
    key: 'custdev', label: 'Cust Dev — обзвон после визита', legacy: 'custdev',
    desc: 'Обзвон тех, кто пришёл и оплатил: как прошло, что улучшить.',
    levels: ['none', 'view', 'edit'],
    levelDesc: { view: 'Видит доску обзвона и отчёт.', edit: 'Оценивает разговоры и отмечает обзвоненных.' },
    windows: [
      { key: 'custdev.list', label: 'Доска обзвона', desc: 'Кого звонить: визит, услуги, телефон, что уже сказали.', levels: ['none', 'view'], enforced: 'rpc:custdev_list' },
    ],
    actions: [
      { key: 'custdev.rate', label: 'Оценить разговор', desc: 'Оценки по итогам звонка и заметка — из них собирается отчёт.', levels: ['none', 'edit'], levelDesc: { edit: 'Ставит оценки и пишет заметку.' }, enforced: 'rpc:custdev_rate' },
    ],
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
  // ROLE_REPORTS_SETTINGS_V1 (2026-09-25) — ОТЧЁТЫ ПО ГРУППАМ.
  //
  // Владелец: «an option to read a report per section for roles». Раздел
  // «Отчёты» был одной галочкой: кассир, которому нужен отчёт кассы, получал
  // вместе с ним и зарплаты всех врачей. Теперь у раздела семь окон — группы
  // отчётов; каждую проверяет сервер (services/report-access.js) по одной
  // карте «вид отчёта → группа» (REPORT_GROUP ниже), и по ней же хаб прячет
  // плитки. Ненастроенная группа живёт по ПРЕЖНЕМУ правилу («Отчёты» выданы —
  // видны все): после обновления никто не теряет ни одного отчёта.
  //
  // «Оплата врачей» — это ЧУЖИЕ начисления: свои врач видит в кабинете всегда,
  // и ни одна из этих галочек этого не отнимает.
  { key: 'reports',     label: 'Отчёты',              legacy: 'reports-hub', desc: 'Отчёты за период и выгрузка в Excel.', levels: ['none', 'view'], levelDesc: { view: 'Открывает отчёты тех групп, что отмечены ниже.' }, windows: [
      { key: 'reports.revenue',    label: 'Выручка и счета', desc: 'Общая выручка, счета и отчёт владельца.', levels: ['none', 'view'], enforced: 'rpc:run_report' },
      { key: 'reports.cashier',    label: 'Касса', desc: 'Отчёт кассира за период: поступления и расходы.', levels: ['none', 'view'], enforced: 'rpc:cashier_report' },
      { key: 'reports.doctor_pay', label: 'Оплата врачей', desc: 'Зарплаты врачей, стационарная доля, отчёты по врачам — начисления каждого врача. Свои начисления врач видит в кабинете всегда.', levels: ['none', 'view'], enforced: 'rpc:run_report' },
      { key: 'reports.referrals',  label: 'Рефералы', desc: 'Кто направил пациентов и вознаграждение за направления.', levels: ['none', 'view'], enforced: 'rpc:run_report' },
      { key: 'reports.services',   label: 'По услугам и рентабельность', desc: 'Отчёт по услугам и рентабельность операций.', levels: ['none', 'view'], enforced: 'rpc:run_report' },
      { key: 'reports.stock',      label: 'Закупки и склад', desc: 'Приход, расход, остатки и сроки годности.', levels: ['none', 'view'], enforced: 'rpc:run_report' },
      { key: 'reports.callcenter', label: 'Колл-центр', desc: 'Загрузка стойки, воронка заявок и работа операторов.', levels: ['none', 'view'], enforced: 'rpc:callcenter_report' },
      // Не выдаётся: охват Telegram-бота — только администратору (сервер
      // telegram_stats — requireAdmin). Строка показана, чтобы было видно, что
      // её нет у роли не по недосмотру.
      { key: 'reports.telegram',   label: 'Telegram-бот', desc: 'Сколько пациентов подключилось к боту. Только администратор.', levels: ['none'], locked: true, enforced: 'rpc:telegram_stats' },
    ], actions: [] },
  // ROLE_REPORTS_SETTINGS_V1 — НАСТРОЙКИ ПО РАЗДЕЛАМ, ГРУППАМИ ХАБА.
  //
  // Окно = плитка хаба настроек; `group` — заголовок карточки хаба, под которым
  // плитка стоит, и экран «Роли» рисует окна этими же группами. «Изменение»
  // здесь НАСТОЯЩЕЕ: у таблиц плитки в реестре (server/db/schema-registry.js)
  // стоит `write.grant` с этим же ключом, и компилятор запросов пускает запись
  // тому, кому окно выдано на «Изменение» (db/write-grant.js). Плитка, чью
  // запись сервер не проверяет по ключу, «Изменения» не предлагает вовсе.
  //
  // `legacyKeys` — прежнее правило, по которому плитка была видна: ключи старой
  // матрицы ('hub' — любой, кто открывает сам хаб). Им экран «Роли» выводит
  // уровень у роли, которую ещё не настраивали, — и выводит только «Просмотр»:
  // писать в эти таблицы до сих пор мог один администратор.
  //
  // `locked` — только администратор, и выдать нельзя: строка видна, но
  // переключателя у неё нет, а сервер ключа не читает.
  //
  // `grantColumns` (ревью I2, решение: деньги — только администратору) — какие
  // колонки таблицы плитки право «Изменение» вправе писать; цены, проценты,
  // ставки и способы оплаты в этот список не входят и остаются за
  // администратором (db/write-grant.js отказывает, если такая колонка есть в
  // записи). Таблицы плитки без записи здесь — без денег, пишутся целиком.
  // Плитка, у которой без денег ничего не остаётся (скидки, полисы,
  // провайдеры, кэшбэк, ставки врачей), — закрытая строка.
  { key: 'settings',    label: 'Настройки',           legacy: 'settings', desc: 'Вся конфигурация клиники: услуги, сотрудники, роли, телефония.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Открывает настройки. Что в них видно и что можно менять, решают разделы ниже.', edit: 'Открывает настройки. Уровень раздела сам ничего не даёт менять — менять можно разделы, выданные ниже на «Изменение».' }, windows: [
      // Сотрудники — тоже только администратор, хотя в списке владельца их
      // нет: весь /api/users стоит за requireRole('admin') (routes/users.js),
      // и «Просмотр» открыл бы экран, который не загрузит ни одной строки.
      { key: 'settings.employees', group: 'Управление пользователями и сотрудниками', label: 'Сотрудники', desc: 'Учётные записи персонала. Только администратор.', levels: ['none'], locked: true, enforced: 'route:employees' },
      { key: 'settings.roles', group: 'Управление пользователями и сотрудниками', label: 'Роли', desc: 'Кто что видит. Только администратор.', levels: ['none'], locked: true, enforced: 'db:role_permissions' },
      // DEPARTMENTS_V1 — экран «Отделы»: список, карточка, формирование.
      { key: 'settings.departments', group: 'Управление пользователями и сотрудниками', label: 'Отделы', desc: 'Отделы клиники: руководитель, команда, помещения, снабжение.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит список отделов и их карточки.', edit: 'Формирует отделы: руководитель, команда, помещения.' }, enforced: 'rpc:department_form' },
      { key: 'settings.services', group: 'Настройки услуг', label: 'Список услуг', desc: 'Все услуги клиники: цены и куда ведёт каждая.', levels: ['none', 'view'], legacyKeys: ['services', 'settings:services'], enforced: 'route:services' },
      { key: 'settings.service_types', group: 'Настройки услуг', label: 'Типы услуг', desc: 'Как услуги сгруппированы в прайсе.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и переименовывает типы услуг. Способ оплаты типа меняет только администратор.' }, legacyKeys: 'hub', grantColumns: { service_types: ['name', 'code', 'active'] }, enforced: 'db:service_types' },
      { key: 'settings.consultation_types', group: 'Настройки услуг', label: 'Консультации врачей', desc: 'Виды консультаций и их стоимость.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и переименовывает виды консультаций. Цены и проценты меняет только администратор.' }, legacyKeys: 'hub', grantColumns: { consultation_types: ['name', 'name_ru', 'name_uz', 'sort_order', 'active'] }, enforced: 'db:consultation_types' },
      { key: 'settings.patients', group: 'Основное', label: 'Пациенты', desc: 'Картотека: данные пациента, контакты, номер карты.', levels: ['none', 'view'], legacyKeys: ['settings:patients'], enforced: 'route:settings:patients' },
      { key: 'settings.patient_categories', group: 'Основное', label: 'Категории пациентов', desc: 'Группы пациентов и скидка каждой группы.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и переименовывает категории. Цены и проценты (скидку группы) меняет только администратор.' }, legacyKeys: 'hub', grantColumns: { patient_categories: ['name', 'tier', 'active'] }, enforced: 'db:patient_categories' },
      { key: 'settings.chronic_conditions', group: 'Основное', label: 'Хронические заболевания', desc: 'Список для анкеты пациента.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Пополняет и правит список.' }, legacyKeys: 'hub', enforced: 'db:chronic_conditions_ref' },
      { key: 'settings.documents', group: 'Основное', label: 'Документы', desc: 'Как выглядят печатные документы.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Меняет оформление печатных документов.' }, legacyKeys: ['documents', 'settings'], enforced: 'db:doc_branding' },
      // Скидка — это и есть деньги: срок, группа и услуги решают, кому она
      // достанется, поэтому делить её на «деньги» и «прочее» нечего (ревью I2).
      { key: 'settings.patient_discounts', group: 'Основное', label: 'Скидки пациентов', desc: 'Промокоды и сертификаты. Только администратор: скидка — это деньги клиники.', levels: ['none'], locked: true, enforced: 'db:patient_discounts' },
      { key: 'settings.crm', group: 'Системные настройки', label: 'CRM-канбан', desc: 'Воронка заявок. Только администратор.', levels: ['none'], locked: true, enforced: 'rpc:crm_config_save' },
      { key: 'settings.telephony', group: 'Системные настройки', label: 'Телефония', desc: 'Подключение Binotel и маршрут звонков. Только администратор.', levels: ['none'], locked: true, enforced: 'rpc:telephony_settings_save' },
      { key: 'settings.telegram', group: 'Системные настройки', label: 'Telegram-бот', desc: 'Токен бота и выдача документов. Только администратор.', levels: ['none'], locked: true, enforced: 'rpc:telegram_settings_save' },
      { key: 'settings.api', group: 'Системные настройки', label: 'API', desc: 'Ключи доступа для партнёрских программ. Только администратор.', levels: ['none'], locked: true, enforced: 'db:api_tokens' },
      { key: 'settings.company', group: 'Настройки Easy-Med', label: 'Компания', desc: 'Название, логотип, фирменный цвет и контакты клиники.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Меняет название, логотип и контакты клиники. Охват лаборатории между зданиями меняет только администратор.' }, legacyKeys: ['documents-settings', 'documents', 'settings'], grantColumns: { doc_settings: ['clinic_name', 'address', 'phone', 'email', 'license', 'logo_data_url', 'accent_color', 'paper_size', 'show_watermark', 'footer_note', 'legal_note'] }, enforced: 'db:doc_settings' },
      { key: 'settings.branches', group: 'Настройки Easy-Med', label: 'Филиалы', desc: 'Адреса зданий клиники.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и правит адреса. Связь зданий — только администратор.' }, legacyKeys: 'hub', enforced: 'db:branches' },
      { key: 'settings.rooms', group: 'Помещения', label: 'Помещения', desc: 'Этажи, кабинеты и палаты: койки, цены, оборудование.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и правит этажи, кабинеты, палаты, койки и оборудование. Цены и проценты, отдел помещения, удаление и врачей кабинета меняет только администратор.' }, legacyKeys: ['rooms-setup', 'settings:rooms', 'settings:wards', 'settings:beds_settings', 'settings:floors', 'settings'], grantColumns: { rooms: ['name', 'code', 'room_type', 'capacity', 'queue_mode', 'floor_id', 'notes', 'active', 'working_hours', 'plan_x', 'plan_y', 'plan_w', 'plan_h'], wards: ['name', 'code', 'floor_id', 'active', 'type', 'color', 'plan_x', 'plan_y', 'plan_w', 'plan_h'], beds: ['code', 'ward_id', 'active', 'type', 'notes'] }, enforced: 'db:rooms' },
      { key: 'settings.payers', group: 'Управление плательщиками', label: 'Компании-плательщики', desc: 'Кто платит за пациента: страховые и компании.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и правит плательщиков.' }, legacyKeys: 'hub', enforced: 'db:payers' },
      // Полис — это процент покрытия, способ оплаты провайдера — его комиссия,
      // правило кэшбэка — его процент: без денег строки пусты (ревью I2).
      { key: 'settings.payer_policies', group: 'Управление плательщиками', label: 'Страховые полисы', desc: 'Что и на сколько процентов покрывает каждый плательщик. Только администратор.', levels: ['none'], locked: true, enforced: 'db:payer_policies' },
      { key: 'settings.payment_providers', group: 'Управление плательщиками', label: 'Провайдеры онлайн-платежей', desc: 'Какую комиссию платит клиника. Только администратор.', levels: ['none'], locked: true, enforced: 'db:payment_providers' },
      { key: 'settings.cashback_rules', group: 'Управление плательщиками', label: 'Кэшбэк', desc: 'Сколько возвращать пациенту и за что. Только администратор.', levels: ['none'], locked: true, enforced: 'db:cashback_rules' },
      { key: 'settings.referral_sources', group: 'Направления', label: 'Список источников', desc: 'Откуда приходят пациенты.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и правит источники: имя, категорию, контакты. Цены и проценты (ставки вознаграждения) и реквизиты выплаты меняет только администратор.' }, legacyKeys: 'hub', grantColumns: { referral_sources: ['name', 'category', 'category_id', 'last_name', 'first_name', 'middle_name', 'phone', 'workplace', 'district', 'active'] }, enforced: 'db:referral_sources' },
      { key: 'settings.referral_source_categories', group: 'Направления', label: 'Категории источников', desc: 'Как сгруппированы источники.', levels: ['none', 'view', 'edit'], levelDesc: { edit: 'Заводит и переименовывает категории. Цены и проценты (стандартные ставки) меняет только администратор.' }, legacyKeys: 'hub', grantColumns: { referral_source_categories: ['name', 'active'] }, enforced: 'db:referral_source_categories' },
      // Ставка врача — это его зарплата: строка только администратора (ревью I2).
      { key: 'settings.doctor_rates', group: 'Зарплата врача', label: 'Ставки врачей', desc: 'Процент врача по каждой услуге. Только администратор.', levels: ['none'], locked: true, enforced: 'db:doctor_rates' },
    ], actions: [] },
];

// ROLE_REPORTS_SETTINGS_V1 — ВИД ОТЧЁТА → ГРУППА (ключ окна раздела «Отчёты»).
//
// Одна карта на оба конца: сервер проверяет по ней run_report, owner_report,
// callcenter_report и cashier_report (services/report-access.js), хаб прячет по
// ней плитки. Вид без записи здесь сервер не выдаёт никому, кроме
// администратора, — новый отчёт обязан прийти сюда вместе со своей плиткой
// (тест reports-hub-v2 сверяет каждую плитку).
//
// Прежние «сырые» виды run_report (payments, invoices, services, visits,
// patients, stock_movements) плиток не имеют, но позвать их можно — они
// разложены по тем же группам; visits и patients — не деньги и не склад, им
// хватает самого раздела («reports»).
export const REPORT_GROUP = Object.freeze({
  total_revenue: 'reports.revenue', invoices_full: 'reports.revenue', owner: 'reports.revenue',
  cashier: 'reports.cashier',
  doctor_salaries: 'reports.doctor_pay', inpatient_share: 'reports.doctor_pay',
  by_doctors: 'reports.doctor_pay', doctor_services: 'reports.doctor_pay',
  referrals: 'reports.referrals', referrals_detail: 'reports.referrals',
  by_services: 'reports.services', surgery_profit: 'reports.services',
  procurement: 'reports.stock', stock_consumption: 'reports.stock',
  stock_statement: 'reports.stock', stock_expiry: 'reports.stock',
  callcenter: 'reports.callcenter',
  // прежние виды run_report
  payments: 'reports.cashier', invoices: 'reports.revenue', services: 'reports.services',
  stock_movements: 'reports.stock', visits: 'reports', patients: 'reports',
});

// ROLE_REPORTS_SETTINGS_V1 — старые ключи, при которых открывается хаб
// настроек (permissions.js isModuleAllowed('settings')): 'settings', любой
// 'settings:<раздел>' и страницы, живущие внутри хаба. Список один — его
// читают и ворота оболочки, и вывод уровней на экране «Роли» (legacyKeys: 'hub').
export const SETTINGS_HUB_LEGACY_KEYS = Object.freeze(['settings', 'documents', 'discounts-settings', 'api-settings', 'doctor-pay', 'consultation-types', 'communications', 'cashier-settings']);

/** Открыт ли хаб настроек по старому списку разделов (без справочника). */
export function settingsHubLegacy(sectionsList) {
  const s = sectionsList instanceof Set ? sectionsList : new Set(sectionsList || []);
  for (const k of s) if (typeof k === 'string' && k.startsWith('settings:')) return true;
  return SETTINGS_HUB_LEGACY_KEYS.some((k) => s.has(k));
}

/**
 * Прежний уровень плитки настроек у роли, которую ещё не настраивали:
 * 'view', если по старым ключам плитка была видна, иначе 'none'. «Изменения»
 * отсюда не бывает: писать в таблицы настроек до сих пор мог только
 * администратор, и вывести его из старых ключей значило бы раздать запись.
 */
export function settingsLegacyView(row, sectionsList) {
  if (!row || row.locked || !row.legacyKeys) return null;
  const s = sectionsList instanceof Set ? sectionsList : new Set(sectionsList || []);
  if (row.legacyKeys === 'hub') return settingsHubLegacy(s) ? 'view' : 'none';
  return row.legacyKeys.some((k) => s.has(k)) ? 'view' : 'none';
}

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
